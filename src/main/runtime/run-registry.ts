import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { writeJsonAtomic } from '../storage/atomic-json'
import { ProcessExitedBeforeRegistrationError, probeEffectiveProcessGroup, probeProcessGroup, probeProcessIdentity, processCommandHasHostIdentity, processIdentityMatches, signalVerifiedProcess, type ExpectedProcessIdentity, type ProcessIdentityProbe } from './process-runner'

const LegacyRunRecordSchema = z.object({
  runId: z.string().uuid(),
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  executable: z.string().min(1),
  processStartedAt: z.string().min(1),
  taskId: z.string().uuid(),
  stage: z.string().min(1),
  registeredAt: z.string().datetime({ offset: true })
})
const RunRecordSchema = LegacyRunRecordSchema.extend({ appInstanceToken: z.string().uuid() })
type RegisteredRunRecord = z.infer<typeof RunRecordSchema>
export type RunRecord = z.infer<typeof LegacyRunRecordSchema> & { appInstanceToken?: string }
export interface RecoveryConfirmation {
  reclaimed: RunRecord[]
  forgotten: RunRecord[]
  unresolved: RunRecord[]
}
const RegistrySchemaV1 = z.object({ schemaVersion: z.literal(1), active: z.array(LegacyRunRecordSchema) })
const RegistrySchemaV2 = z.object({ schemaVersion: z.literal(2), active: z.array(z.union([RunRecordSchema, LegacyRunRecordSchema])) })
const RegistrySchema = z.union([RegistrySchemaV1, RegistrySchemaV2])

const registryQueues = new Map<string, Promise<void>>()
const REGISTRATION_PROBE_ATTEMPTS = 10
const REGISTRATION_PROBE_DELAY_MS = 25

export class RunRegistry {
  #recoveryCohort: Set<string> | undefined

  constructor(readonly path: string, readonly signalGraceMs = 2_000, readonly appInstanceToken = randomUUID()) {}

  async load(): Promise<RunRecord[]> {
    try { return RegistrySchema.parse(JSON.parse(await readFile(this.path, 'utf8'))).active }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return []
    }
  }

  async register(input: Omit<RegisteredRunRecord, 'processStartedAt' | 'registeredAt'>): Promise<RunRecord> {
    return this.#serial(async () => {
      const records = await this.load()
      if (input.appInstanceToken !== this.appInstanceToken) throw new Error('进程 host 不属于当前 Etch 实例，拒绝登记')
      if (records.some((record) => record.taskId === input.taskId)) {
        throw new Error(`任务 ${input.taskId} 仍有活动 Provider 进程登记，拒绝启动新进程`)
      }
      if (records.some((record) => record.runId === input.runId)) {
        throw new Error(`Provider 运行 ${input.runId} 已经登记`)
      }
      let identity: ProcessIdentityProbe = { state: 'unknown' }
      let verified = false
      for (let attempt = 0; attempt < REGISTRATION_PROBE_ATTEMPTS; attempt += 1) {
        identity = await probeProcessIdentity(input.pid)
        if (identity.state === 'absent') break
        if (identity.state === 'present') {
          verified = identity.pgid === input.pgid
            && processIdentityMatches({ ...input, processStartedAt: identity.startedAt }, identity)
            && processCommandHasHostIdentity(identity.command, input)
          if (verified) break
        }
        if (attempt + 1 < REGISTRATION_PROBE_ATTEMPTS) {
          await delay(REGISTRATION_PROBE_DELAY_MS)
        }
      }
      if (identity.state === 'absent' && await this.#groupIsEffectivelyAbsent(input.pgid)) {
        throw new ProcessExitedBeforeRegistrationError()
      }
      if (!verified || identity.state !== 'present') {
        throw new Error('无法证明新进程身份与进程组，拒绝登记')
      }
      const record = RunRecordSchema.parse({ ...input, processStartedAt: identity.startedAt, registeredAt: new Date().toISOString() })
      await this.#save([...records, record])
      return record
    })
  }

  async finish(runId: string): Promise<void> {
    await this.#serial(async () => {
      const records = await this.load()
      const record = records.find((item) => item.runId === runId)
      if (!record) return
      const reclaimed = await this.#terminateGroup(record, true)
      if (!reclaimed) throw new Error(`外部进程 ${record.pid} 的进程组仍存活或身份无法验证，拒绝删除持久登记`)
      await this.#save(records.filter((item) => item.runId !== runId))
    })
  }

  async hasActiveTask(taskId: string): Promise<boolean> {
    return this.#serial(async () => (await this.load()).some((record) => record.taskId === taskId))
  }

  async activeCurrent(): Promise<RunRecord[]> {
    return this.#serial(async () => (await this.load()).filter((record) => record.appInstanceToken === this.appInstanceToken))
  }

  async stopCurrent(): Promise<number> {
    return this.#serial(async () => {
      const records = await this.load()
      const targets = records.filter((record) => record.appInstanceToken === this.appInstanceToken)
      const outcomes = await Promise.all(targets.map(async (record) => ({
        record,
        stopped: await this.#terminateGroup(record, true)
      })))
      const stopped = new Set(outcomes.filter((outcome) => outcome.stopped).map((outcome) => outcome.record.runId))
      const failures = outcomes.filter((outcome) => !outcome.stopped).map((outcome) => outcome.record)
      if (stopped.size) await this.#save(records.filter((record) => !stopped.has(record.runId)))
      if (failures.length) {
        throw new Error(`无法安全停止当前 Etch 实例的外部进程：${failures.map((record) => record.pid).join(', ')}`)
      }
      return stopped.size
    })
  }

  async stopTask(taskId: string): Promise<number> {
    return this.#serial(async () => {
      const records = await this.load()
      const targets = records.filter((record) => record.taskId === taskId)
      if (!targets.length) return 0
      const outcomes = await Promise.all(targets.map(async (record) => ({
        record,
        stopped: await this.#terminateGroup(record, true)
      })))
      const stopped = new Set(outcomes.filter((outcome) => outcome.stopped).map((outcome) => outcome.record.runId))
      if (stopped.size) await this.#save(records.filter((record) => !stopped.has(record.runId)))
      const failed = outcomes.find((outcome) => !outcome.stopped)?.record
      if (failed) throw new Error(`无法安全停止任务 ${taskId} 的外部进程 ${failed.pid}`)
      return stopped.size
    })
  }

  async recover(): Promise<{ reclaimed: RunRecord[]; unverified: RunRecord[] }> {
    return this.#serial(async () => {
      const reclaimed: RunRecord[] = []
      const unverified: RunRecord[] = []
      const survivors: RunRecord[] = []
      for (const record of await this.load()) {
        const identity = await probeProcessIdentity(record.pid)
        if (identity.state === 'absent') {
          if (await this.#groupIsEffectivelyAbsent(record.pgid)) continue
          unverified.push(record)
          survivors.push(record)
          continue
        }
        if (identity.state === 'unknown') {
          unverified.push(record)
          survivors.push(record)
          continue
        }
        if (identity.state === 'present' && !this.#matches(record, identity)) {
          unverified.push(record)
          if (!await this.#groupIsEffectivelyAbsent(record.pgid)) survivors.push(record)
          continue
        }
        if (await this.#terminateGroup(record, false)) {
          reclaimed.push(record)
          continue
        }
        unverified.push(record)
        survivors.push(record)
      }
      await this.#save(survivors)
      this.#recoveryCohort = new Set(survivors.map((record) => record.runId))
      return { reclaimed, unverified }
    })
  }

  async confirmRecovery(): Promise<RecoveryConfirmation> {
    return this.#serial(async () => {
      const reclaimed: RunRecord[] = []
      const forgotten: RunRecord[] = []
      const unresolved: RunRecord[] = []
      const records = await this.load()
      const recoveryCohort = this.#recoveryCohort ?? new Set<string>()
      const currentRuns = records.filter((record) => !recoveryCohort.has(record.runId))
      for (const record of records.filter((item) => recoveryCohort.has(item.runId))) {
        const identity = await probeProcessIdentity(record.pid)
        const group = await probeEffectiveProcessGroup(record.pgid)
        if (group === 'absent') {
          forgotten.push(record)
          continue
        }
        if (!record.appInstanceToken) {
          forgotten.push(record)
          continue
        }
        if (identity.state === 'present' && !this.#matches(record, identity)) {
          forgotten.push(record)
          continue
        }
        if (identity.state === 'unknown' || group === 'unknown') {
          unresolved.push(record)
          continue
        }
        if (await this.#terminateGroup(record, true)) reclaimed.push(record)
        else unresolved.push(record)
      }
      await this.#save([...currentRuns, ...unresolved])
      this.#recoveryCohort = new Set(unresolved.map((record) => record.runId))
      return { reclaimed, forgotten, unresolved }
    })
  }

  #expected(record: RunRecord): ExpectedProcessIdentity {
    return {
      pid: record.pid,
      pgid: record.pgid,
      executable: record.executable,
      processStartedAt: record.processStartedAt,
      runId: record.appInstanceToken ? record.runId : undefined,
      appInstanceToken: record.appInstanceToken
    }
  }

  #matches(record: RunRecord, identity: Extract<ProcessIdentityProbe, { state: 'present' }>): boolean {
    return Boolean(record.appInstanceToken) && processIdentityMatches(this.#expected(record), identity)
  }

  async #signalVerified(record: RunRecord, signal: NodeJS.Signals, allowLeaderlessGroup: boolean): Promise<'signaled' | 'gone' | 'mismatch' | 'failed'> {
    if (!record.appInstanceToken) return 'mismatch'
    return signalVerifiedProcess(this.#expected(record), signal, allowLeaderlessGroup)
  }

  async #waitUntilGroupGone(record: RunRecord): Promise<boolean> {
    const deadline = Date.now() + this.signalGraceMs
    do {
      if (probeProcessGroup(record.pgid) === 'absent') return true
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, this.signalGraceMs)))
    } while (Date.now() < deadline)
    return this.#groupIsEffectivelyAbsent(record.pgid)
  }

  async #terminateGroup(record: RunRecord, allowLeaderlessGroup: boolean): Promise<boolean> {
    if (await this.#groupIsEffectivelyAbsent(record.pgid)) return true
    const term = await this.#signalVerified(record, 'SIGTERM', allowLeaderlessGroup)
    if (term === 'gone') return this.#groupIsEffectivelyAbsent(record.pgid)
    if (term !== 'signaled') return false
    if (await this.#waitUntilGroupGone(record)) return true
    const kill = await this.#signalVerified(record, 'SIGKILL', allowLeaderlessGroup)
    if (kill === 'gone') return this.#groupIsEffectivelyAbsent(record.pgid)
    return kill === 'signaled' && await this.#waitUntilGroupGone(record)
  }

  async #groupIsEffectivelyAbsent(pgid: number): Promise<boolean> {
    return await probeEffectiveProcessGroup(pgid) === 'absent'
  }

  async #save(records: RunRecord[]): Promise<void> {
    await writeJsonAtomic(this.path, { schemaVersion: 2, active: records })
  }

  async #serial<T>(operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.path)
    const previous = registryQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => gate)
    registryQueues.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (registryQueues.get(key) === queued) registryQueues.delete(key)
    }
  }
}

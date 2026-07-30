import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { AtomicWriteCommittedError, writeJsonAtomic } from './atomic-json'

async function writeAppStateAllowCommitted(path: string, value: unknown): Promise<void> {
  try {
    await writeJsonAtomic(path, value)
  } catch (error) {
    if (!(error instanceof AtomicWriteCommittedError)) throw error
    console.error('app-state.json 已原子替换，但父目录 durability sync 失败；保留已提交状态', error.cause)
  }
}

const AppStateSchema = z.object({
  schemaVersion: z.literal(1),
  cleanExit: z.boolean(),
  recoveryHold: z.boolean(),
  fullDiskAccessOnboardingShown: z.boolean().default(false),
  updatedAt: z.string().datetime({ offset: true })
})
export type AppState = z.infer<typeof AppStateSchema>

export class AppStateStore {
  constructor(readonly path: string) {}
  async load(): Promise<AppState> {
    try { return AppStateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessOnboardingShown: false, updatedAt: new Date().toISOString() }
    }
  }
  async beginLaunch(): Promise<AppState> {
    const current = await this.load()
    const next = { ...current, cleanExit: false, recoveryHold: !current.cleanExit || current.recoveryHold, updatedAt: new Date().toISOString() }
    await writeJsonAtomic(this.path, next)
    return next
  }
  async markCleanExit(): Promise<void> {
    const current = await this.load()
    await writeAppStateAllowCommitted(this.path, { ...current, cleanExit: true, updatedAt: new Date().toISOString() })
  }
  async releaseRecoveryHold(): Promise<void> {
    const current = await this.load()
    await writeAppStateAllowCommitted(this.path, { ...current, recoveryHold: false, updatedAt: new Date().toISOString() })
  }
  async holdRecovery(): Promise<void> {
    const current = await this.load()
    await writeJsonAtomic(this.path, { ...current, recoveryHold: true, updatedAt: new Date().toISOString() })
  }
  async claimFullDiskAccessOnboarding(): Promise<boolean> {
    const current = await this.load()
    if (current.fullDiskAccessOnboardingShown) return false
    await writeAppStateAllowCommitted(this.path, { ...current, fullDiskAccessOnboardingShown: true, updatedAt: new Date().toISOString() })
    return true
  }
}

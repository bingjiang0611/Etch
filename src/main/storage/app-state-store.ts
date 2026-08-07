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
  fullDiskAccessGuideDismissed: z.boolean().default(false),
  updatedAt: z.string().datetime({ offset: true })
})
export type AppState = z.infer<typeof AppStateSchema>

export class AppStateStore {
  constructor(readonly path: string) {}
  async load(): Promise<AppState> {
    try { return AppStateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, cleanExit: true, recoveryHold: false, fullDiskAccessGuideDismissed: false, updatedAt: new Date().toISOString() }
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
  /**
   * 只记录“用户主动跳过”，不记录“弹过一次”；授权真的到位后立即复位，
   * 这样用户日后撤销权限还能重新被引导。
   */
  async setFullDiskAccessGuideDismissed(dismissed: boolean): Promise<void> {
    const current = await this.load()
    if (current.fullDiskAccessGuideDismissed === dismissed) return
    await writeAppStateAllowCommitted(this.path, { ...current, fullDiskAccessGuideDismissed: dismissed, updatedAt: new Date().toISOString() })
  }
}

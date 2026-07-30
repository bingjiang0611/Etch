import type { AppStateStore } from '../storage/app-state-store'
import type { RunRecord, RunRegistry } from './run-registry'

type RecoveryWarning = (message: string, detail: Record<string, unknown>) => void

export async function requireRecoveryConfirmationForUnverifiedRuns(
  records: readonly RunRecord[],
  appStateStore: AppStateStore,
  warn: RecoveryWarning = console.warn
): Promise<number> {
  if (!records.length) return 0
  for (const record of records) {
    warn('Provider 孤儿进程组无法在冷启动中安全确认；未发送任何信号，等待用户确认恢复', {
      taskId: record.taskId,
      stage: record.stage,
      pid: record.pid,
      pgid: record.pgid,
      reason: 'process identity or process-group ownership could not be verified'
    })
  }
  await appStateStore.holdRecovery()
  return records.length
}

export async function recoverProviderRunsAtStartup(
  runRegistry: RunRegistry,
  appStateStore: AppStateStore,
  warn: RecoveryWarning = console.warn
): Promise<{ reclaimed: RunRecord[]; unverified: RunRecord[]; unverifiedRuns: number }> {
  const recovery = await runRegistry.recover()
  const unverifiedRuns = await requireRecoveryConfirmationForUnverifiedRuns(recovery.unverified, appStateStore, warn)
  return { ...recovery, unverifiedRuns }
}

export async function confirmProviderRecovery(
  runRegistry: RunRegistry,
  appStateStore: AppStateStore,
  warn: RecoveryWarning = console.warn
): Promise<{ released: boolean; unresolved: number }> {
  const confirmation = await runRegistry.confirmRecovery()
  for (const record of confirmation.reclaimed) {
    warn('用户确认后已回收 Etch 持久登记的 Provider 进程组', {
      taskId: record.taskId,
      stage: record.stage,
      pid: record.pid,
      pgid: record.pgid,
      reason: 'confirmed orphan process-group cleanup'
    })
  }
  for (const record of confirmation.forgotten) {
    warn('用户确认后已移除不再对应活动 Etch 进程的持久登记', {
      taskId: record.taskId,
      stage: record.stage,
      pid: record.pid,
      pgid: record.pgid,
      reason: 'process group absent or process identity changed'
    })
  }
  if (confirmation.unresolved.length) {
    for (const record of confirmation.unresolved) {
      warn('用户确认后仍无法安全处理 Provider 进程组，继续保持恢复锁', {
        taskId: record.taskId,
        stage: record.stage,
        pid: record.pid,
        pgid: record.pgid,
        reason: 'process identity or process-group state remains unknown'
      })
    }
    await appStateStore.holdRecovery()
    return { released: false, unresolved: confirmation.unresolved.length }
  }
  await appStateStore.releaseRecoveryHold()
  return { released: true, unresolved: 0 }
}

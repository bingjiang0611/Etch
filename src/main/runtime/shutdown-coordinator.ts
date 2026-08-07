export type ShutdownMode = 'cancel' | 'drain-current-stage' | 'stop-now'

export const ENVIRONMENT_RUN_STAGE = 'environment'

export interface ShutdownPipeline {
  readonly activeStageCount: number
  freezeAcquisition(): void
  thawAcquisition(): void
  whenIdle(): Promise<void>
  stopAllNow(): Promise<void>
}

export interface ShutdownRunRegistry {
  activeCurrent(): Promise<Array<{ stage: string }>>
  stopCurrent(): Promise<number>
}

export interface ShutdownAsyncRuns {
  whenIdle(): Promise<void>
}

export type ShutdownResult =
  | { state: 'cancelled' }
  | { state: 'clean' }
  | { state: 'unclean'; error: unknown }

export async function coordinateShutdown(options: {
  pipeline: ShutdownPipeline
  runRegistry: ShutdownRunRegistry
  appRuns: ShutdownAsyncRuns
  publicationActive(): boolean
  chooseMode(activeWorkers: number): Promise<ShutdownMode>
  markCleanExit(): Promise<void>
  stopTimeoutMs?: number
}): Promise<ShutdownResult> {
  options.pipeline.freezeAcquisition()
  try {
    const taskRunCount = async (): Promise<number> =>
      (await options.runRegistry.activeCurrent()).filter((run) => run.stage !== ENVIRONMENT_RUN_STAGE).length
    const activeWorkers = Math.max(
      options.pipeline.activeStageCount,
      options.publicationActive() ? 1 : 0,
      await taskRunCount()
    )
    const mode = activeWorkers ? await options.chooseMode(activeWorkers) : 'drain-current-stage'
    if (mode === 'cancel') {
      options.pipeline.thawAcquisition()
      return { state: 'cancelled' }
    }

    if (mode === 'stop-now') {
      await withTimeout(Promise.all([
        options.pipeline.stopAllNow(),
        options.appRuns.whenIdle()
      ]).then(() => undefined), options.stopTimeoutMs ?? 15_000)
    } else if (activeWorkers) {
      await Promise.all([options.pipeline.whenIdle(), options.appRuns.whenIdle()])
    } else {
      await withTimeout(
        Promise.all([options.pipeline.whenIdle(), options.appRuns.whenIdle()]).then(() => undefined),
        options.stopTimeoutMs ?? 15_000
      ).catch((error) => console.warn('退出前空闲收敛超时，改按真实在途工作判定', error))
    }

    if ((await options.runRegistry.activeCurrent()).length) await options.runRegistry.stopCurrent()

    const remainingTaskRuns = await taskRunCount()
    if (options.pipeline.activeStageCount !== 0 || options.publicationActive() || remainingTaskRuns !== 0) {
      throw new Error(`退出收敛失败：仍有 ${options.pipeline.activeStageCount} 个执行中阶段、${options.publicationActive() ? 1 : 0} 个投稿任务、${remainingTaskRuns} 个任务外部进程`)
    }
    await options.markCleanExit()
    return { state: 'clean' }
  } catch (error) {
    options.pipeline.thawAcquisition()
    return { state: 'unclean', error }
  }
}

export function handleShutdownResult(
  result: ShutdownResult,
  actions: {
    cancelled(): void
    unclean(error: unknown): void
    clean(): void
  }
): void {
  if (result.state === 'cancelled') actions.cancelled()
  else if (result.state === 'unclean') actions.unclean(result.error)
  else actions.clean()
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`立即停止等待超过 ${timeoutMs}ms`)), timeoutMs)
        timer.unref()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

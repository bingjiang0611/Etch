export type ShutdownMode = 'cancel' | 'drain-current-stage' | 'stop-now'

export interface ShutdownPipeline {
  readonly runningCount: number
  freezeAcquisition(): void
  thawAcquisition(): void
  whenIdle(): Promise<void>
  stopAllNow(): Promise<void>
}

export interface ShutdownRunRegistry {
  activeCurrent(): Promise<unknown[]>
}

export interface ShutdownAsyncRuns {
  readonly runningCount: number
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
  chooseMode(activeWorkers: number): Promise<ShutdownMode>
  markCleanExit(): Promise<void>
  stopTimeoutMs?: number
}): Promise<ShutdownResult> {
  options.pipeline.freezeAcquisition()
  try {
    const activeWorkers = Math.max(
      options.pipeline.runningCount,
      options.appRuns.runningCount,
      (await options.runRegistry.activeCurrent()).length
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
    } else {
      await Promise.all([options.pipeline.whenIdle(), options.appRuns.whenIdle()])
    }

    const remainingRuns = await options.runRegistry.activeCurrent()
    if (options.pipeline.runningCount !== 0 || options.appRuns.runningCount !== 0 || remainingRuns.length !== 0) {
      throw new Error(`退出收敛失败：仍有 ${options.pipeline.runningCount} 个流水线任务、${options.appRuns.runningCount} 个应用级调用、${remainingRuns.length} 个外部进程`)
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

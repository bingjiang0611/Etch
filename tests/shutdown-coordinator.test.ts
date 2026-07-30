import { describe, expect, it, vi } from 'vitest'
import { coordinateShutdown, handleShutdownResult, type ShutdownMode, type ShutdownPipeline } from '../src/main/runtime/shutdown-coordinator'
import { AsyncRunScope } from '../src/main/runtime/async-run-scope'

function pipeline(runningCount = 1): ShutdownPipeline & { setRunning(count: number): void } {
  let running = runningCount
  return {
    get runningCount() { return running },
    setRunning(count) { running = count },
    freezeAcquisition: vi.fn(),
    thawAcquisition: vi.fn(),
    whenIdle: vi.fn(async () => { running = 0 }),
    stopAllNow: vi.fn(async () => { running = 0 })
  }
}

function idleAppRuns() {
  return { runningCount: 0, whenIdle: vi.fn(async () => undefined) }
}

describe('coordinateShutdown', () => {
  it('thaws acquisition and preserves the unclean launch marker when exit is cancelled', async () => {
    const work = pipeline()
    const markCleanExit = vi.fn()
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: { activeCurrent: async () => [{}] },
      appRuns: idleAppRuns(),
      chooseMode: async (): Promise<ShutdownMode> => 'cancel',
      markCleanExit
    })

    expect(result).toEqual({ state: 'cancelled' })
    expect(work.freezeAcquisition).toHaveBeenCalledOnce()
    expect(work.thawAcquisition).toHaveBeenCalledOnce()
    expect(markCleanExit).not.toHaveBeenCalled()
  })

  it.each([
    ['drain-current-stage', 'whenIdle'],
    ['stop-now', 'stopAllNow']
  ] as const)('waits for both authorities before marking a %s exit clean', async (mode, operation) => {
    const work = pipeline()
    let registryActive = true
    const markCleanExit = vi.fn(async () => undefined)
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: { activeCurrent: async () => registryActive ? [{}] : [] },
      appRuns: idleAppRuns(),
      chooseMode: async () => {
        registryActive = false
        return mode
      },
      markCleanExit
    })

    expect(result).toEqual({ state: 'clean' })
    expect(work[operation]).toHaveBeenCalledOnce()
    expect(markCleanExit).toHaveBeenCalledOnce()
  })

  it('leaves the launch unclean if a current-instance process remains registered', async () => {
    const work = pipeline()
    const markCleanExit = vi.fn()
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: { activeCurrent: async () => [{}] },
      appRuns: idleAppRuns(),
      chooseMode: async () => 'drain-current-stage',
      markCleanExit
    })

    expect(result.state).toBe('unclean')
    expect(work.thawAcquisition).toHaveBeenCalledOnce()
    expect(markCleanExit).not.toHaveBeenCalled()
  })

  it('waits for an app-scoped run even while the durable registry is empty', async () => {
    const work = pipeline(0)
    const appRuns = new AsyncRunScope()
    let finishRun!: () => void
    appRuns.track(new Promise<void>((resolve) => { finishRun = resolve }))
    const markCleanExit = vi.fn(async () => undefined)
    const shutdown = coordinateShutdown({
      pipeline: work,
      runRegistry: { activeCurrent: async () => [] },
      appRuns,
      chooseMode: async () => 'drain-current-stage',
      markCleanExit
    })

    await Promise.resolve()
    expect(markCleanExit).not.toHaveBeenCalled()
    finishRun()
    await expect(shutdown).resolves.toEqual({ state: 'clean' })
    expect(markCleanExit).toHaveBeenCalledOnce()
  })

  it('does not route an unclean result through the clean exit action', () => {
    const actions = {
      cancelled: vi.fn(),
      unclean: vi.fn(),
      clean: vi.fn()
    }
    const error = new Error('still active')

    handleShutdownResult({ state: 'unclean', error }, actions)

    expect(actions.unclean).toHaveBeenCalledWith(error)
    expect(actions.cancelled).not.toHaveBeenCalled()
    expect(actions.clean).not.toHaveBeenCalled()
  })

  it('resumes acquisition when the clean marker cannot be written', async () => {
    const work = pipeline(0)
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: { activeCurrent: async () => [] },
      appRuns: idleAppRuns(),
      chooseMode: async () => 'drain-current-stage',
      markCleanExit: async () => { throw new Error('app state unavailable') }
    })

    expect(result).toMatchObject({ state: 'unclean' })
    expect(work.thawAcquisition).toHaveBeenCalledOnce()
  })
})

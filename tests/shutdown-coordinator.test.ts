import { describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_RUN_STAGE, coordinateShutdown, handleShutdownResult, type ShutdownMode, type ShutdownPipeline } from '../src/main/runtime/shutdown-coordinator'
import { AsyncRunScope } from '../src/main/runtime/async-run-scope'

function pipeline(activeStageCount = 1): ShutdownPipeline & { setActiveStages(count: number): void } {
  let active = activeStageCount
  return {
    get activeStageCount() { return active },
    setActiveStages(count) { active = count },
    freezeAcquisition: vi.fn(),
    thawAcquisition: vi.fn(),
    whenIdle: vi.fn(async () => { active = 0 }),
    stopAllNow: vi.fn(async () => { active = 0 })
  }
}

function idleAppRuns() {
  return { whenIdle: vi.fn(async () => undefined) }
}

function registry(stages: string[] = []) {
  let rows = stages.map((stage) => ({ stage }))
  return {
    activeCurrent: vi.fn(async () => rows),
    stopCurrent: vi.fn(async () => {
      const stopped = rows.length
      rows = []
      return stopped
    }),
    setStages(next: string[]) { rows = next.map((stage) => ({ stage })) }
  }
}

describe('coordinateShutdown', () => {
  it('thaws acquisition and preserves the unclean launch marker when exit is cancelled', async () => {
    const work = pipeline()
    const markCleanExit = vi.fn()
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: registry(['translate']),
      appRuns: idleAppRuns(),
      publicationActive: () => false,
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
    const runs = registry(['burn'])
    const markCleanExit = vi.fn(async () => undefined)
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: runs,
      appRuns: idleAppRuns(),
      publicationActive: () => false,
      chooseMode: async () => {
        runs.setStages([])
        return mode
      },
      markCleanExit
    })

    expect(result).toEqual({ state: 'clean' })
    expect(work[operation]).toHaveBeenCalledOnce()
    expect(markCleanExit).toHaveBeenCalledOnce()
  })

  it('leaves the launch unclean when a task process stays registered and cannot be stopped', async () => {
    const work = pipeline()
    const runs = registry(['translate'])
    runs.stopCurrent = vi.fn(async () => { throw new Error('无法安全停止外部进程') })
    const markCleanExit = vi.fn()
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: runs,
      appRuns: idleAppRuns(),
      publicationActive: () => false,
      chooseMode: async () => 'drain-current-stage',
      markCleanExit
    })

    expect(result.state).toBe('unclean')
    expect(work.thawAcquisition).toHaveBeenCalledOnce()
    expect(markCleanExit).not.toHaveBeenCalled()
  })

  it('prompts for a Bilibili publication that is still in flight', async () => {
    const work = pipeline(0)
    let publishing = true
    const chooseMode = vi.fn(async (): Promise<ShutdownMode> => {
      publishing = false
      return 'drain-current-stage'
    })
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: registry([]),
      appRuns: idleAppRuns(),
      publicationActive: () => publishing,
      chooseMode,
      markCleanExit: async () => undefined
    })

    expect(chooseMode).toHaveBeenCalledWith(1)
    expect(result).toEqual({ state: 'clean' })
  })

  it('prompts for a registered task process even while no stage counter is set', async () => {
    const work = pipeline(0)
    const runs = registry(['publish:bilibili'])
    const chooseMode = vi.fn(async (): Promise<ShutdownMode> => {
      runs.setStages([])
      return 'drain-current-stage'
    })
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: runs,
      appRuns: idleAppRuns(),
      publicationActive: () => false,
      chooseMode,
      markCleanExit: async () => undefined
    })

    expect(chooseMode).toHaveBeenCalledWith(1)
    expect(result).toEqual({ state: 'clean' })
  })

  it('exits without prompting while only environment probes are in flight and stops them', async () => {
    const work = pipeline(0)
    const runs = registry([ENVIRONMENT_RUN_STAGE, ENVIRONMENT_RUN_STAGE, ENVIRONMENT_RUN_STAGE])
    const appRuns = new AsyncRunScope()
    let finishProbe!: () => void
    appRuns.track(new Promise<void>((resolve) => { finishProbe = resolve }))
    const chooseMode = vi.fn(async (): Promise<ShutdownMode> => 'cancel')
    const markCleanExit = vi.fn(async () => undefined)
    const shutdown = coordinateShutdown({
      pipeline: work,
      runRegistry: runs,
      appRuns,
      publicationActive: () => false,
      chooseMode,
      markCleanExit
    })

    finishProbe()
    await expect(shutdown).resolves.toEqual({ state: 'clean' })
    expect(chooseMode).not.toHaveBeenCalled()
    expect(runs.stopCurrent).toHaveBeenCalledOnce()
    expect(markCleanExit).toHaveBeenCalledOnce()
  })

  it('exits without prompting when tasks are only admitted or queued and no stage is executing', async () => {
    const work = pipeline(0)
    const chooseMode = vi.fn(async (): Promise<ShutdownMode> => 'cancel')
    const markCleanExit = vi.fn(async () => undefined)
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: registry([]),
      appRuns: idleAppRuns(),
      publicationActive: () => false,
      chooseMode,
      markCleanExit
    })

    expect(chooseMode).not.toHaveBeenCalled()
    expect(work.freezeAcquisition).toHaveBeenCalledOnce()
    expect(work.whenIdle).toHaveBeenCalledOnce()
    expect(result).toEqual({ state: 'clean' })
    expect(markCleanExit).toHaveBeenCalledOnce()
  })

  it('still exits cleanly when an idle pipeline never settles and nothing is really in flight', async () => {
    const work = pipeline(0)
    work.whenIdle = vi.fn(() => new Promise<void>(() => undefined))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const chooseMode = vi.fn(async (): Promise<ShutdownMode> => 'cancel')
    const result = await coordinateShutdown({
      pipeline: work,
      runRegistry: registry([]),
      appRuns: idleAppRuns(),
      publicationActive: () => false,
      chooseMode,
      markCleanExit: async () => undefined,
      stopTimeoutMs: 20
    })

    expect(chooseMode).not.toHaveBeenCalled()
    expect(result).toEqual({ state: 'clean' })
    expect(warn).toHaveBeenCalled()
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
      runRegistry: registry([]),
      appRuns: idleAppRuns(),
      publicationActive: () => false,
      chooseMode: async () => 'drain-current-stage',
      markCleanExit: async () => { throw new Error('app state unavailable') }
    })

    expect(result).toMatchObject({ state: 'unclean' })
    expect(work.thawAcquisition).toHaveBeenCalledOnce()
  })
})

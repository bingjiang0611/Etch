import { describe, expect, it } from 'vitest'
import { PoolCancelledError, StagePools } from '../src/main/pipeline/pool'

describe('StagePools', () => {
  it('applies the requested concurrency limit through every mapped stage pool', async () => {
    for (const stage of ['source', 'english', 'cues', 'translate', 'audit', 'burn'] as const) {
      const pools = new StagePools(3)
      let active = 0
      let peak = 0
      let release!: () => void
      let started!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const firstStarted = new Promise<void>((resolve) => { started = resolve })
      const runs = Array.from({ length: 3 }, () => pools.runStage(stage, 1, async () => {
        active += 1
        peak = Math.max(peak, active)
        started()
        await gate
        active -= 1
      }))

      await firstStarted
      expect(peak).toBe(1)
      release()
      await Promise.all(runs)
      expect(active).toBe(0)
    }
  })

  it('reports occupancy and free slots for the stage that is being scheduled', async () => {
    const pools = new StagePools(1)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const burnStarted = new Promise<void>((resolve) => { started = resolve })
    const running = pools.runStage('burn', 1, async () => {
      started()
      await gate
    })
    const waiting = pools.runStage('burn', 1, async () => undefined)

    await burnStarted
    expect(pools.hasFreeSlot('burn', 1)).toBe(false)
    expect(pools.hasFreeSlot('source', 1)).toBe(true)
    expect(pools.hasFreeSlot('srt', 1)).toBe(true)
    expect(pools.occupancy()).toMatchObject({ ffmpeg: { active: 1, waiting: 1 }, download: { active: 0, waiting: 0 } })

    release()
    await Promise.all([running, waiting])
    expect(pools.hasFreeSlot('burn', 1)).toBe(true)
    expect(pools.occupancy().ffmpeg).toEqual({ active: 0, waiting: 0 })
  })

  it('removes an aborted waiter without starting its operation', async () => {
    const pools = new StagePools(1)
    let release!: () => void
    let startedFirst!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve })
    const first = pools.runStage('translate', 1, async () => {
      startedFirst()
      await gate
    })
    const controller = new AbortController()
    let started = false
    const waiting = pools.runStage('translate', 1, async () => { started = true }, controller.signal)

    await firstStarted
    controller.abort()

    await expect(waiting).rejects.toBeInstanceOf(PoolCancelledError)
    expect(started).toBe(false)
    release()
    await first
  })

  it('rechecks cancellation after a slot is granted', async () => {
    const pools = new StagePools(1)
    const controller = new AbortController()
    controller.abort()
    let started = false

    await expect(pools.runStage('translate', 1, async () => { started = true }, controller.signal))
      .rejects.toBeInstanceOf(PoolCancelledError)
    expect(started).toBe(false)
  })
})

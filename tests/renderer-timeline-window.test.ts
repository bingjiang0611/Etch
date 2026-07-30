import { describe, expect, it, vi } from 'vitest'
import type { ReviewTimelineWindow } from '../src/shared/ipc'
import { TimelineWindowCoordinator, type TimelineRequestIdentity } from '../src/renderer/timeline-window-coordinator'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function identity(taskId = 'task-a', revision = 1): TimelineRequestIdentity {
  return { taskId, revision, englishSha256: 'a'.repeat(64), chineseSha256: 'b'.repeat(64) }
}

function timeline(request: TimelineRequestIdentity, rangeStartMs: number, rangeEndMs: number): ReviewTimelineWindow {
  return {
    taskId: request.taskId,
    revision: request.revision,
    artifactIdentity: `${request.taskId}-${request.revision}`,
    rangeStartMs,
    rangeEndMs,
    items: [{
      cueId: 1,
      startMs: rangeStartMs,
      endMs: rangeEndMs,
      english: 'Cue',
      chinese: '字幕'
    }]
  }
}

describe('TimelineWindowCoordinator', () => {
  it('keeps one request in flight and follows the latest seek when the first window misses it', async () => {
    const requests: Array<ReturnType<typeof deferred<ReviewTimelineWindow>>> = []
    let active = 0
    let maximumActive = 0
    const fetch = vi.fn((request: TimelineRequestIdentity, milliseconds: number) => {
      void request
      void milliseconds
      active += 1
      maximumActive = Math.max(maximumActive, active)
      const pending = deferred<ReviewTimelineWindow>()
      requests.push(pending)
      return pending.promise.finally(() => { active -= 1 })
    })
    const publish = vi.fn()
    const coordinator = new TimelineWindowCoordinator(fetch, publish)
    const current = identity()

    coordinator.request(current, 201_000)
    coordinator.request(current, 240_000)
    expect(fetch).toHaveBeenCalledTimes(1)

    requests[0].resolve(timeline(current, 200_000, 202_000))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[1][1]).toBe(240_000)
    expect(publish).not.toHaveBeenCalled()

    requests[1].resolve(timeline(current, 239_000, 241_000))
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ rangeStartMs: 239_000 }))
    expect(maximumActive).toBe(1)
  })

  it('does not issue a redundant follow-up when the first window covers the latest seek', async () => {
    const pending = deferred<ReviewTimelineWindow>()
    const fetch = vi.fn(() => pending.promise)
    const publish = vi.fn()
    const coordinator = new TimelineWindowCoordinator(fetch, publish)
    const current = identity()

    coordinator.request(current, 100)
    coordinator.request(current, 105)
    pending.resolve(timeline(current, 0, 200))
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('lets a new identity proceed without waiting for an obsolete request', async () => {
    const requests: Array<ReturnType<typeof deferred<ReviewTimelineWindow>>> = []
    const fetch = vi.fn((request: TimelineRequestIdentity, milliseconds: number) => {
      void request
      void milliseconds
      const pending = deferred<ReviewTimelineWindow>()
      requests.push(pending)
      return pending.promise
    })
    const publish = vi.fn()
    const coordinator = new TimelineWindowCoordinator(fetch, publish)
    const first = identity('task-a', 1)
    const second = identity('task-b', 2)

    coordinator.request(first, 100)
    coordinator.request(second, 500)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0]).toEqual(second)
    expect(fetch.mock.calls[1][1]).toBe(500)

    requests[1].resolve(timeline(second, 450, 550))
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-b' }))

    requests[0].resolve(timeline(first, 0, 200))
    await Promise.resolve()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('does not let a never-settling old task starve the current task', async () => {
    const oldRequest = new Promise<ReviewTimelineWindow>(() => undefined)
    const currentRequest = deferred<ReviewTimelineWindow>()
    const fetch = vi.fn()
      .mockReturnValueOnce(oldRequest)
      .mockReturnValueOnce(currentRequest.promise)
    const publish = vi.fn()
    const coordinator = new TimelineWindowCoordinator(fetch, publish)
    const first = identity('task-a', 1)
    const second = identity('task-b', 2)

    coordinator.request(first, 100)
    coordinator.request(second, 500)
    expect(fetch).toHaveBeenCalledTimes(2)

    currentRequest.resolve(timeline(second, 450, 550))
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-b' })))
  })

  it('invalidates an in-flight window when artifact hashes change at the same revision', async () => {
    const requests: Array<ReturnType<typeof deferred<ReviewTimelineWindow>>> = []
    const fetch = vi.fn(() => {
      const pending = deferred<ReviewTimelineWindow>()
      requests.push(pending)
      return pending.promise
    })
    const publish = vi.fn()
    const coordinator = new TimelineWindowCoordinator(fetch, publish)
    const first = identity('task-a', 3)
    const replaced = { ...first, englishSha256: 'c'.repeat(64) }

    coordinator.request(first, 201_000)
    coordinator.request(replaced, 240_000)
    expect(fetch).toHaveBeenCalledTimes(2)

    requests[0].resolve(timeline(first, 200_000, 202_000))
    requests[1].resolve(timeline(replaced, 239_000, 241_000))
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ rangeStartMs: 239_000 }))
  })

  it('follows a newer seek even when the first request rejects', async () => {
    const requests: Array<ReturnType<typeof deferred<ReviewTimelineWindow>>> = []
    const fetch = vi.fn((request: TimelineRequestIdentity, milliseconds: number) => {
      void request
      void milliseconds
      const pending = deferred<ReviewTimelineWindow>()
      requests.push(pending)
      return pending.promise
    })
    const coordinator = new TimelineWindowCoordinator(fetch, vi.fn())
    const current = identity()

    coordinator.request(current, 100)
    coordinator.request(current, 300)
    requests[0].reject(new Error('temporary IPC failure'))

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[1][1]).toBe(300)
    requests[1].resolve(timeline(current, 250, 350))
  })
})

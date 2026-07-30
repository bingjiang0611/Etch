import { describe, expect, it, vi } from 'vitest'
import { detectInitialToolsWithRetry } from '../src/renderer/tool-detection'

type Health = { status: 'ready' | 'missing' }

const complete = (result: readonly Health[]): boolean => result.every((item) => item.status === 'ready')
const noWait = async (): Promise<void> => undefined

describe('detectInitialToolsWithRetry', () => {
  it('retries an incomplete initial result and stops when all tools are ready', async () => {
    const detect = vi
      .fn<() => Promise<Health[]>>()
      .mockResolvedValueOnce([{ status: 'ready' }, { status: 'missing' }])
      .mockResolvedValueOnce([{ status: 'ready' }, { status: 'ready' }])
    const wait = vi.fn(noWait)

    await expect(detectInitialToolsWithRetry(detect, { complete, wait })).resolves.toEqual([
      { status: 'ready' },
      { status: 'ready' }
    ])
    expect(detect).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('retries transient errors and preserves the final error', async () => {
    const finalError = new Error('still unavailable')
    const detect = vi.fn<() => Promise<Health[]>>().mockRejectedValueOnce(new Error('warming up')).mockRejectedValueOnce(finalError)

    await expect(detectInitialToolsWithRetry(detect, { attempts: 2, complete, wait: noWait })).rejects.toBe(finalError)
    expect(detect).toHaveBeenCalledTimes(2)
  })

  it('returns the final incomplete snapshot after the retry limit', async () => {
    const snapshots: Health[][] = [
      [{ status: 'missing' }],
      [{ status: 'ready' }, { status: 'missing' }],
      [{ status: 'missing' }, { status: 'ready' }]
    ]
    const detect = vi.fn<() => Promise<Health[]>>()
    snapshots.forEach((snapshot) => detect.mockResolvedValueOnce(snapshot))

    await expect(detectInitialToolsWithRetry(detect, { complete, wait: noWait })).resolves.toEqual(snapshots[2])
    expect(detect).toHaveBeenCalledTimes(3)
  })

  it('does not start another detection after its owner stops', async () => {
    let active = true
    const detect = vi.fn<() => Promise<Health[]>>().mockResolvedValue([{ status: 'missing' }])
    const wait = async (): Promise<void> => {
      active = false
    }

    await expect(detectInitialToolsWithRetry(detect, { complete, wait, shouldContinue: () => active })).resolves.toEqual([{ status: 'missing' }])
    expect(detect).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

const { writeJsonAtomicMock } = vi.hoisted(() => ({
  writeJsonAtomicMock: vi.fn()
}))

vi.mock('../src/main/storage/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/storage/atomic-json')>()
  return { ...actual, writeJsonAtomic: writeJsonAtomicMock }
})

import { AtomicWriteCommittedError } from '../src/main/storage/atomic-json'
import { AppStateStore } from '../src/main/storage/app-state-store'

afterEach(() => {
  writeJsonAtomicMock.mockReset()
  vi.restoreAllMocks()
})

describe('AppStateStore atomic durability outcomes', () => {
  it.each(['beginLaunch', 'holdRecovery'] as const)('fails closed when %s cannot durably sync', async (operation) => {
    writeJsonAtomicMock.mockRejectedValueOnce(
      new AtomicWriteCommittedError('/missing/app-state.json', new Error('directory fsync failed'))
    )
    const store = new AppStateStore('/missing/app-state.json')

    await expect(store[operation]()).rejects.toThrow('父目录同步失败')
  })

  it('accepts a visibly committed clean marker because an older marker is conservatively unclean', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    writeJsonAtomicMock.mockRejectedValueOnce(
      new AtomicWriteCommittedError('/missing/app-state.json', new Error('directory fsync failed'))
    )

    await expect(new AppStateStore('/missing/app-state.json').markCleanExit()).resolves.toBeUndefined()
  })
})

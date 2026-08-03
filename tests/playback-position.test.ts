import { describe, expect, it } from 'vitest'
import { clearPlaybackPosition, loadPlaybackPosition, savePlaybackPosition } from '../src/renderer/playback-position'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) }
  }
}

describe('playback position persistence', () => {
  it('stores independent positions for each task', () => {
    const storage = memoryStorage()
    savePlaybackPosition(storage, 'task-a', 12.5)
    savePlaybackPosition(storage, 'task-b', 37)

    expect(loadPlaybackPosition(storage, 'task-a', 60)).toBe(12.5)
    expect(loadPlaybackPosition(storage, 'task-b', 60)).toBe(37)
  })

  it.each([
    ['invalid JSON', '{'],
    ['negative seconds', JSON.stringify({ seconds: -1 })],
    ['non-numeric seconds', JSON.stringify({ seconds: '12' })],
    ['position at duration', JSON.stringify({ seconds: 60 })],
    ['position beyond duration', JSON.stringify({ seconds: 61 })]
  ])('discards %s', (_label, value) => {
    const storage = memoryStorage()
    storage.values.set('etch:playback-position:task-a', value)

    expect(loadPlaybackPosition(storage, 'task-a', 60)).toBeUndefined()
    expect(storage.values.size).toBe(0)
  })

  it('clears completed playback and tolerates unavailable storage', () => {
    const storage = memoryStorage()
    savePlaybackPosition(storage, 'task-a', 12)
    clearPlaybackPosition(storage, 'task-a')
    expect(loadPlaybackPosition(storage, 'task-a', 60)).toBeUndefined()

    const unavailable = {
      getItem: (): string | null => { throw new Error('unavailable') },
      setItem: (): void => { throw new Error('unavailable') },
      removeItem: (): void => { throw new Error('unavailable') }
    }
    expect(() => savePlaybackPosition(unavailable, 'task-a', 12)).not.toThrow()
    expect(loadPlaybackPosition(unavailable, 'task-a', 60)).toBeUndefined()
    expect(() => clearPlaybackPosition(unavailable, 'task-a')).not.toThrow()
  })
})

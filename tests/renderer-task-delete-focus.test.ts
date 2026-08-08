import { describe, expect, it } from 'vitest'
import { deleteFocusNeighborId } from '../src/renderer/task-delete-focus'

describe('删除任务后的焦点接管', () => {
  it('hands focus to the following card so the queue keeps its scroll position', () => {
    expect(deleteFocusNeighborId(['a', 'b', 'c'], 'b')).toBe('c')
    expect(deleteFocusNeighborId(['a', 'b', 'c'], 'a')).toBe('b')
  })

  it('falls back to the previous card when the deleted task was last', () => {
    expect(deleteFocusNeighborId(['a', 'b', 'c'], 'c')).toBe('b')
  })

  it('reports no neighbour when the queue holds no other task', () => {
    expect(deleteFocusNeighborId(['a'], 'a')).toBeUndefined()
    expect(deleteFocusNeighborId([], 'a')).toBeUndefined()
    expect(deleteFocusNeighborId(['a', 'b'], 'missing')).toBeUndefined()
  })
})

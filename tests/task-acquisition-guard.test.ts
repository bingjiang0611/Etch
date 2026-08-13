import { describe, expect, it } from 'vitest'
import { TaskAcquisitionGuard } from '../src/main/task-acquisition-guard'

describe('TaskAcquisitionGuard', () => {
  it('blocks only the selected canonical task directory and releases it after deletion', () => {
    const guard = new TaskAcquisitionGuard()

    guard.block('/workspace/task-a')
    expect(guard.isBlocked('/workspace/task-a/.')).toBe(true)
    expect(guard.isBlocked('/workspace/task-b')).toBe(false)

    guard.unblock('/workspace/task-a/.')
    expect(guard.isBlocked('/workspace/task-a')).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { PipelinePowerManager } from '../src/main/runtime/power'

describe('PipelinePowerManager', () => {
  it('holds one blocker only while enabled workers are active', () => {
    const adapter = { start: vi.fn(() => 42), stop: vi.fn() }
    const manager = new PipelinePowerManager(adapter, true)

    manager.setActiveWorkers(1)
    manager.setActiveWorkers(3)
    expect(adapter.start).toHaveBeenCalledOnce()
    expect(adapter.start).toHaveBeenCalledWith('prevent-app-suspension')

    manager.setEnabled(false)
    expect(adapter.stop).toHaveBeenCalledWith(42)
    manager.setEnabled(true)
    expect(adapter.start).toHaveBeenCalledTimes(2)

    manager.setActiveWorkers(0)
    expect(adapter.stop).toHaveBeenCalledTimes(2)
    manager.dispose()
    expect(adapter.stop).toHaveBeenCalledTimes(2)
  })
})

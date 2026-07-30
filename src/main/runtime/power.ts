export interface PowerSaveBlockerAdapter {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

export class PipelinePowerManager {
  #activeWorkers = 0
  #enabled: boolean
  #blockerId?: number

  constructor(readonly adapter: PowerSaveBlockerAdapter, enabled: boolean) {
    this.#enabled = enabled
  }

  setActiveWorkers(count: number): void {
    this.#activeWorkers = Math.max(0, count)
    this.#reconcile()
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    this.#reconcile()
  }

  dispose(): void {
    this.#activeWorkers = 0
    this.#enabled = false
    this.#reconcile()
  }

  #reconcile(): void {
    const shouldBlock = this.#enabled && this.#activeWorkers > 0
    if (shouldBlock && this.#blockerId === undefined) {
      try {
        this.#blockerId = this.adapter.start('prevent-app-suspension')
      } catch (error) {
        console.error('power save blocker start failed', error)
      }
      return
    }
    if (!shouldBlock && this.#blockerId !== undefined) {
      const blockerId = this.#blockerId
      this.#blockerId = undefined
      try {
        this.adapter.stop(blockerId)
      } catch (error) {
        console.error('power save blocker stop failed', error)
      }
    }
  }
}

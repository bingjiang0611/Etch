export class AsyncRunScope {
  readonly #runs = new Set<Promise<unknown>>()

  get runningCount(): number {
    return this.#runs.size
  }

  track<T>(run: Promise<T>): Promise<T> {
    this.#runs.add(run)
    const forget = (): void => { this.#runs.delete(run) }
    void run.then(forget, forget)
    return run
  }

  async whenIdle(): Promise<void> {
    while (this.#runs.size) {
      await Promise.allSettled([...this.#runs])
    }
  }
}

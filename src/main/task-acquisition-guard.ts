import { resolve } from 'node:path'

export class TaskAcquisitionGuard {
  readonly #blockedDirectories = new Set<string>()

  block(taskDirectory: string): void {
    this.#blockedDirectories.add(resolve(taskDirectory))
  }

  unblock(taskDirectory: string): void {
    this.#blockedDirectories.delete(resolve(taskDirectory))
  }

  isBlocked(taskDirectory: string): boolean {
    return this.#blockedDirectories.has(resolve(taskDirectory))
  }
}

import { writeAtomic } from './atomic-write'

export class AtomicWriteCommittedError extends Error {
  constructor(readonly path: string, readonly cause: unknown) {
    super(`JSON 已替换但父目录同步失败：${path}`)
    this.name = 'AtomicWriteCommittedError'
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeAtomic(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    (cause) => new AtomicWriteCommittedError(path, cause)
  )
}

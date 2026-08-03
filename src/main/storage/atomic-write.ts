import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeAtomic(
  path: string,
  value: string | Uint8Array,
  committedError?: (cause: unknown) => unknown
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  let file: Awaited<ReturnType<typeof open>> | undefined
  let replaced = false
  try {
    file = await open(tempPath, 'wx', 0o600)
    await file.writeFile(value, typeof value === 'string' ? 'utf8' : undefined)
    await file.sync()
    await file.close()
    file = undefined
    await rename(tempPath, path)
    replaced = true
    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await file?.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    if (replaced && committedError) throw committedError(error)
    throw error
  }
}

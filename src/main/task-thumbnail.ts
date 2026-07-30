import type { TaskManifest } from '../shared/task-schema'
import { readContainedFile } from './storage/safe-artifact'

type Artifact = TaskManifest['artifacts'][string]

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

function imageMime(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  throw new Error('封面产物不是受支持的图片格式')
}

export class TaskThumbnailService {
  readonly #cache = new Map<string, { sha256: string; dataUrl: string }>()

  async read(taskId: string, taskDirectory: string, artifact: Artifact): Promise<string> {
    const cached = this.#cache.get(taskId)
    if (cached?.sha256 === artifact.sha256) return cached.dataUrl
    const file = await readContainedFile(taskDirectory, artifact.relativePath, '任务封面', {
      maxBytes: MAX_THUMBNAIL_BYTES,
      expectedSize: artifact.size,
      expectedSha256: artifact.sha256
    })
    const dataUrl = `data:${imageMime(file.bytes)};base64,${file.bytes.toString('base64')}`
    this.#cache.set(taskId, { sha256: artifact.sha256, dataUrl })
    return dataUrl
  }

  forget(taskId: string): void {
    this.#cache.delete(taskId)
  }
}

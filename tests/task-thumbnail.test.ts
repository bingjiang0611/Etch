import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskThumbnailService } from '../src/main/task-thumbnail'
import { createTaskManifest, taskThumbnailArtifact, type TaskManifest } from '../src/shared/task-schema'

type Artifact = TaskManifest['artifacts'][string]

const directories: string[] = []
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlHYAAAAASUVORK5CYII=', 'base64')

afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function taskDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'etch-thumbnail-'))
  directories.push(path)
  return path
}

function artifact(relativePath: string, bytes: Buffer): Artifact {
  return {
    relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    valid: true,
    producer: 'test',
    inputFingerprint: '0'.repeat(64),
  }
}

describe('TaskThumbnailService', () => {
  it('prefers an explicit thumbnail and limits the legacy media fallback to X documents', () => {
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://example.com/article' },
      'Document',
      undefined,
      '',
      'standard',
      false,
      'document'
    )
    const documentMedia = artifact('media-001.png', png)
    manifest.artifacts['documentMedia:media-001'] = documentMedia

    expect(taskThumbnailArtifact(manifest)).toBeUndefined()
    manifest.document.resolvedSource = 'x-article'
    expect(taskThumbnailArtifact(manifest)).toBe(documentMedia)

    const explicit = artifact('thumbnail.png', png)
    manifest.artifacts.thumbnail = explicit
    expect(taskThumbnailArtifact(manifest)).toBe(explicit)
  })

  it('returns a validated image data URL and caches it by task and hash', async () => {
    const directory = await taskDirectory()
    const image = artifact('thumbnail.png', png)
    await writeFile(join(directory, image.relativePath), png)
    const service = new TaskThumbnailService()

    const first = await service.read('task-1', directory, image)
    expect(first).toBe(`data:image/png;base64,${png.toString('base64')}`)

    await rm(join(directory, image.relativePath))
    await expect(service.read('task-1', directory, image)).resolves.toBe(first)
    service.forget('task-1')
    await expect(service.read('task-1', directory, image)).rejects.toThrow()
  })

  it('rejects a hash mismatch and unsupported image bytes', async () => {
    const directory = await taskDirectory()
    await writeFile(join(directory, 'thumbnail.png'), png)
    const service = new TaskThumbnailService()
    const wrongHash = { ...artifact('thumbnail.png', png), sha256: 'f'.repeat(64) }
    await expect(service.read('task-hash', directory, wrongHash)).rejects.toThrow('SHA-256 不匹配')

    const text = Buffer.from('not an image')
    await writeFile(join(directory, 'thumbnail.bin'), text)
    await expect(service.read('task-format', directory, artifact('thumbnail.bin', text))).rejects.toThrow('不是受支持的图片格式')
  })

  it('rejects paths outside the task directory and oversized files', async () => {
    const directory = await taskDirectory()
    const service = new TaskThumbnailService()
    await expect(service.read('task-path', directory, artifact('../thumbnail.png', png))).rejects.toThrow('路径无效')

    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1)
    png.copy(oversized)
    await writeFile(join(directory, 'oversized.png'), oversized)
    await expect(service.read('task-size', directory, artifact('oversized.png', oversized))).rejects.toThrow('过大')
  })
})

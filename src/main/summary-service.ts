import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageCapabilityInfo, SummaryPage } from '../shared/ipc'
import { PROVIDER_IDS_FOR_IMAGES, imageCapability } from './providers/image-adapters'
import { summaryImageArtifactKey, type TaskManifest } from '../shared/task-schema'
import { readContainedFile } from './storage/safe-artifact'

type Artifact = TaskManifest['artifacts'][string]

const MAX_ARTICLE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function imageCapabilities(): ImageCapabilityInfo[] {
  return PROVIDER_IDS_FOR_IMAGES.map((provider) => {
    const capability = imageCapability(provider)
    return capability.available
      ? { provider, available: true }
      : { provider, available: false, reason: capability.reason }
  })
}

function exportDirectoryName(manifest: TaskManifest): string {
  const safe = [...manifest.title]
    .map((character) => (/[/\\:*?"<>|]/u.test(character) || character.charCodeAt(0) < 32 ? ' ' : character))
    .join('')
    .trim()
    .slice(0, 80) || 'summary'
  return `${safe}--${manifest.taskId.slice(0, 8)}`
}

export class SummaryService {
  readonly #imageCache = new Map<string, { sha256: string; dataUrl: string }>()

  async page(taskId: string, taskDirectory: string, manifest: TaskManifest): Promise<SummaryPage> {
    const base = {
      taskId,
      revision: manifest.revision,
      illustrationPhase: manifest.summary.illustration.phase,
      imageCapabilities: imageCapabilities()
    }
    if (manifest.kind !== 'summary') {
      return { ...base, availability: 'not-ready' as const, message: '当前任务不是视频总结任务', markdown: '', images: [] }
    }
    const article = manifest.artifacts.summaryArticle
    if (!article?.valid) {
      return { ...base, availability: 'not-ready' as const, message: '总结还没生成完成', markdown: '', images: [] }
    }
    const markdown = await this.#text(taskDirectory, article, '总结正文', MAX_ARTICLE_BYTES)
    const pending = new Map(manifest.summary.illustration.pending.map((item) => [item.filename, item.reason]))
    const images = manifest.summary.illustration.planned.map((image) => {
      const artifact = manifest.artifacts[summaryImageArtifactKey(image.filename)]
      const ready = Boolean(artifact?.valid) && manifest.summary.illustration.generated.includes(image.filename)
      return {
        filename: image.filename,
        alt: image.alt,
        anchor: image.anchor,
        status: ready ? ('ready' as const) : ('pending' as const),
        sha256: ready ? artifact!.sha256 : undefined,
        reason: ready ? undefined : pending.get(image.filename) ?? '待生成'
      }
    })
    return {
      ...base,
      availability: 'ready' as const,
      markdown,
      images,
      draftRecord: manifest.summary.draftRecord
    }
  }

  async image(
    taskId: string,
    taskDirectory: string,
    manifest: TaskManifest,
    filename: string,
    expectedSha256: string
  ): Promise<string | undefined> {
    const artifact = manifest.artifacts[summaryImageArtifactKey(filename)]
    if (!artifact?.valid || artifact.sha256 !== expectedSha256) return undefined
    const cacheKey = `${taskId}:${filename}`
    const cached = this.#imageCache.get(cacheKey)
    if (cached?.sha256 === artifact.sha256) return cached.dataUrl
    const file = await readContainedFile(taskDirectory, artifact.relativePath, '总结配图', {
      maxBytes: MAX_IMAGE_BYTES,
      expectedSize: artifact.size,
      expectedSha256: artifact.sha256
    })
    if (!file.bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('总结配图不是 PNG')
    const dataUrl = `data:image/png;base64,${file.bytes.toString('base64')}`
    if (this.#imageCache.size > 24) this.#imageCache.clear()
    this.#imageCache.set(cacheKey, { sha256: artifact.sha256, dataUrl })
    return dataUrl
  }

  // 导出成一个自包含目录：summary.md 里的 images/<file> 相对路径直接可用。
  async export(taskDirectory: string, manifest: TaskManifest, targetDirectory: string): Promise<{ directory: string; images: number }> {
    const article = manifest.artifacts.summaryArticle
    if (manifest.kind !== 'summary' || !article?.valid) throw new Error('当前任务没有可导出的总结')
    const markdown = await this.#text(taskDirectory, article, '总结正文', MAX_ARTICLE_BYTES)
    const directory = join(targetDirectory, exportDirectoryName(manifest))
    await mkdir(join(directory, 'images'), { recursive: true })
    await writeFile(join(directory, 'summary.md'), markdown, 'utf8')
    if (manifest.summary.draftRecord) {
      const drafts = manifest.artifacts.summaryDrafts
      if (drafts?.valid) {
        await writeFile(join(directory, 'drafts.md'), await this.#text(taskDirectory, drafts, '三稿执行记录', MAX_ARTICLE_BYTES), 'utf8')
      }
    }
    let images = 0
    for (const filename of manifest.summary.illustration.generated) {
      const artifact = manifest.artifacts[summaryImageArtifactKey(filename)]
      if (!artifact?.valid) continue
      const file = await readContainedFile(taskDirectory, artifact.relativePath, '总结配图', {
        maxBytes: MAX_IMAGE_BYTES,
        expectedSize: artifact.size,
        expectedSha256: artifact.sha256
      })
      await writeFile(join(directory, 'images', filename), file.bytes)
      images += 1
    }
    return { directory, images }
  }

  forget(taskId: string): void {
    for (const key of [...this.#imageCache.keys()]) {
      if (key.startsWith(`${taskId}:`)) this.#imageCache.delete(key)
    }
  }

  async #text(taskDirectory: string, artifact: Artifact, label: string, maxBytes: number): Promise<string> {
    const file = await readContainedFile(taskDirectory, artifact.relativePath, label, {
      maxBytes,
      expectedSize: artifact.size,
      expectedSha256: artifact.sha256
    })
    return file.bytes.toString('utf8')
  }
}

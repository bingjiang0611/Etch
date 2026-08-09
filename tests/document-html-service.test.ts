import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentHtmlService, documentHtmlStaticIssues, type DocumentHtmlBrowserVerifier } from '../src/main/document-html-service'
import { sha256File } from '../src/main/core/fingerprint'
import { IndexStore } from '../src/main/storage/index-store'
import { TaskStore } from '../src/main/storage/task-store'
import { createTaskManifest, type TaskManifest } from '../src/shared/task-schema'

type Artifact = TaskManifest['artifacts'][string]
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function artifact(directory: string, relativePath: string): Promise<Artifact> {
  const path = join(directory, relativePath)
  const info = await stat(path)
  return {
    relativePath,
    sha256: await sha256File(path),
    size: info.size,
    valid: true,
    producer: 'fixture',
    inputFingerprint: '1'.repeat(64)
  }
}

async function fixture(browserVerify?: DocumentHtmlBrowserVerifier) {
  const directory = await mkdtemp(join(tmpdir(), 'etch-document-html-'))
  directories.push(directory)
  const mediaPath = '.etch-artifacts/inspect/media-001.png'
  await mkdir(dirname(join(directory, mediaPath)), { recursive: true })
  await Promise.all([
    writeFile(join(directory, 'source.md'), `# Article\n\nA paragraph with **detail**.\n\n| Metric | Value |\n| --- | --- |\n| Quality | High |\n\n![cover](${mediaPath})\n`),
    writeFile(join(directory, mediaPath), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  ])
  const manifest = createTaskManifest(
    { kind: 'url', url: 'https://example.com/article' },
    'Article',
    undefined,
    '',
    'standard',
    false,
    'document',
    '',
    'convert'
  )
  manifest.document.resolvedAction = 'convert'
  manifest.pipeline.stages.verify.status = 'completed'
  manifest.artifacts.sourceMarkdown = await artifact(directory, 'source.md')
  manifest.artifacts['documentMedia:media-001'] = await artifact(directory, mediaPath)
  const store = new TaskStore()
  const index = new IndexStore()
  await store.create(directory, manifest)
  index.upsert(directory, manifest)
  const verifier = browserVerify ?? vi.fn<DocumentHtmlBrowserVerifier>(async (_html, desktop, mobile) => {
    await Promise.all([writeFile(desktop, Buffer.from('desktop')), writeFile(mobile, Buffer.from('mobile'))])
    return { issues: [] }
  })
  return { directory, manifest, store, index, verifier, service: new DocumentHtmlService(store, index, verifier) }
}

describe('DocumentHtmlService', () => {
  it('生成四方向预览、确认方向、验收并导出单文件 HTML', async () => {
    const item = await fixture()
    const checkpoint = await item.service.start(item.manifest.taskId, item.manifest.revision)
    expect(checkpoint.document.htmlPublication).toMatchObject({ status: 'checkpoint', phase: 'preview' })

    const page = await item.service.page(item.manifest.taskId)
    expect(page.previewHtml).toContain('四方向试衣间')
    expect(page.previewHtml).toContain('data-direction="D"')

    const completed = await item.service.resolveStyle(item.manifest.taskId, checkpoint.revision, 'B')
    expect(completed.document.htmlPublication).toMatchObject({ status: 'completed', phase: 'done', selectedDirection: 'B', templateId: 'minimal' })
    expect(completed.artifacts.documentHtml.valid).toBe(true)
    expect(completed.artifacts['documentHtmlScreenshot:desktop'].valid).toBe(true)
    expect(item.verifier).toHaveBeenCalledOnce()

    const html = await readFile(join(item.directory, completed.artifacts.documentHtml.relativePath), 'utf8')
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<table>')
    expect(html).toContain('Content-Security-Policy')
    expect(html).not.toMatch(/fonts\.googleapis\.com|cdn\.tailwindcss\.com/iu)
    expect(html).not.toContain('<script')
    const target = await mkdtemp(join(tmpdir(), 'etch-document-html-export-'))
    directories.push(target)
    const exported = await item.service.exportTo(item.manifest.taskId, target)
    expect(exported).toBe(join(target, 'source.html'))
    expect(await sha256File(exported)).toBe(completed.artifacts.documentHtml.sha256)
  })

  it('静态门禁拒绝远程 script/link 并要求严格离线 CSP', () => {
    const base = '<!DOCTYPE html><html><head></head><body><main><article>ok</article></main></body></html>'
    expect(documentHtmlStaticIssues(base)).toContain('缺少严格离线 CSP')
    expect(documentHtmlStaticIssues(base.replace('</head>', '<script src="https://evil.example/x.js"></script></head>')))
      .toContain('HTML 不允许 script')
    expect(documentHtmlStaticIssues(base.replace('</head>', '<link rel="stylesheet" href="//evil.example/x.css"></head>')))
      .toContain('HTML 不允许远程 link')
  })

  it('浏览器验收器 reject 时标记失败且不发布 HTML artifact', async () => {
    const item = await fixture(async () => {
      throw new Error('browser verifier crashed')
    })
    await expect(item.service.start(item.manifest.taskId, item.manifest.revision, 'template', 'minimal')).rejects.toThrow('browser verifier crashed')
    const saved = await item.store.load(item.directory)
    expect(saved.document.htmlPublication.status).toBe('failed')
    expect(saved.document.htmlPublication.errorCode).toContain('browser verifier crashed')
    expect(saved.artifacts.documentHtml).toBeUndefined()
  })

  it('拒绝把未本地化的远程图片静默发布成不完整 HTML', async () => {
    const item = await fixture()
    await writeFile(join(item.directory, 'source.md'), '# Article\n\n![remote](https://example.com/remote.png)\n')
    const sourceMarkdown = await artifact(item.directory, 'source.md')
    const current = await item.store.mutate(item.directory, (draft) => {
      draft.artifacts.sourceMarkdown = sourceMarkdown
    })
    item.index.upsert(item.directory, current)

    await expect(item.service.start(current.taskId, current.revision, 'template', 'minimal'))
      .rejects.toThrow('未完成本地化的图片')
    expect(item.verifier).not.toHaveBeenCalled()
    expect((await item.store.load(item.directory)).document.htmlPublication.status).toBe('failed')
  })

  it('启动恢复把遗留 running publication 标为可重试失败', async () => {
    const item = await fixture()
    const running = await item.store.mutate(item.directory, (draft) => {
      draft.document.htmlPublication = {
        status: 'running',
        phase: 'generate',
        inputArtifactKey: 'sourceMarkdown',
        inputSha256: draft.artifacts.sourceMarkdown.sha256,
        publicationRunId: '11111111-1111-4111-8111-111111111111'
      }
    })
    item.index.upsert(item.directory, running)

    await item.service.recoverInterrupted()

    const recovered = await item.store.load(item.directory)
    expect(recovered.document.htmlPublication.status).toBe('failed')
    expect(recovered.document.htmlPublication.errorCode).toContain('异常中断')
  })
})

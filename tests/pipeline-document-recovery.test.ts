import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../src/main/runtime/process-runner', () => ({ runProcess: runProcessMock }))
vi.mock('../src/main/runtime/shell-env', () => ({
  loginShellEnvironment: async () => ({ PATH: '/mock' }),
  operationalEnvironment: (env: NodeJS.ProcessEnv) => env,
  providerEnvironment: (_provider: string, env: NodeJS.ProcessEnv) => env,
  logChildEnvironmentKeys: () => undefined
}))
vi.mock('../src/main/runtime/tool-detector', () => ({
  detectTool: async (tool: string) => ({
    tool,
    status: 'ready',
    executable: `/mock/${tool}`,
    version: `${tool} 1.0`,
    summaryZh: `${tool} 可用`
  }),
  identityStillMatches: async () => true,
  toolCacheKey: (tool: string, override?: string) => `${tool}:${override ?? ''}`
}))

import { createMarkdownBlocks, type MarkdownDocument } from '../src/core/document'
import { sha256File } from '../src/main/core/fingerprint'
import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { PROVIDER_SESSION_CONTAMINATED_PREFIX } from '../src/main/providers/session-errors'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, type TaskManifest } from '../src/shared/task-schema'

const directories: string[] = []

afterEach(async () => {
  runProcessMock.mockReset()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function artifact(directory: string, relativePath: string): Promise<TaskManifest['artifacts'][string]> {
  const info = await stat(join(directory, relativePath))
  return {
    relativePath,
    sha256: await sha256File(join(directory, relativePath)),
    size: info.size,
    valid: true,
    producer: 'fixture',
    inputFingerprint: '1'.repeat(64)
  }
}

function qoderResult(text: string, sessionId: string) {
  return {
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
      JSON.stringify({ type: 'result', subtype: 'success', result: text })
    ].join('\n'),
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false
  }
}

function sectionData(prompt: string, section: string): Array<{ id: string; markdown: string }> {
  const envelope = prompt.split(/\r?\n/u).find((line) => line.startsWith(`{"section":"${section}"`))
  if (!envelope) throw new Error(`missing ${section} prompt section`)
  return (JSON.parse(envelope) as { data: Array<{ id: string; markdown: string }> }).data
}

describe('document translation recovery', () => {
  it('reuses all verified draft batches after a real interrupted recovery without requiring a new draft session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-document-recovery-'))
    directories.push(directory)
    const store = new TaskStore()
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://example.com/document-recovery' },
      'Recovery document',
      'qoder',
      '',
      'standard',
      false,
      'document',
      '',
      'translate',
      'normal'
    )
    const sourceDocument: MarkdownDocument = {
      metadata: {
        processingMode: 'translate',
        targetLanguage: 'zh-CN',
        fetchedAt: '2026-08-09T00:00:00.000Z',
        contentType: 'web',
        sourceUrl: 'https://example.com/document-recovery',
        sourceLanguage: 'en'
      },
      blocks: createMarkdownBlocks(Array.from({ length: 41 }, () => ({
        type: 'paragraph' as const,
        markdown: 'Source paragraph about systems and reliability.'
      }))),
      warnings: []
    }
    await writeFile(join(directory, 'source-document.json'), `${JSON.stringify(sourceDocument)}\n`, 'utf8')
    manifest.pipeline.stages.source.status = 'completed'
    manifest.pipeline.stages.inspect.status = 'completed'
    manifest.pipeline.stages.translate.status = 'ready'
    manifest.document.resolvedAction = 'translate'
    manifest.document.resolvedSource = 'web'
    manifest.document.sourceLanguage = 'en'
    manifest.document.blockCount = sourceDocument.blocks.length
    manifest.artifacts.sourceDocument = await artifact(directory, 'source-document.json')
    await store.create(directory, manifest)

    runProcessMock.mockImplementation(async (spec: { args: string[]; stdin: string }) => {
      const resumeIndex = spec.args.indexOf('-r')
      const newIndex = spec.args.indexOf('--session-id')
      const sessionId = spec.args[resumeIndex >= 0 ? resumeIndex + 1 : newIndex + 1]
      if (spec.stdin.includes('document-analysis-blocks')) {
        return qoderResult(JSON.stringify({
          contentType: 'article',
          tone: 'technical',
          audience: 'developers',
          glossary: [],
          risks: []
        }), sessionId)
      }
      const blocks = sectionData(spec.stdin, 'document-blocks')
      return qoderResult(JSON.stringify({
        blocks: blocks.map((block) => ({ id: block.id, markdown: '中文段落。' }))
      }), sessionId)
    })
    const pipeline = new TaskPipeline(
      store,
      defaultSettings('/Users/test'),
      new HistoricalGlossaryService(store, () => []),
      () => undefined
    )

    await pipeline.start(directory)

    const firstRun = await store.load(directory)
    const originalGenerationId = firstRun.translation.activeGenerationId
    const originalBatchFingerprints = firstRun.document.translationBatches.map((batch) => batch.inputFingerprint)
    expect(firstRun.document.translationBatches).toHaveLength(2)
    expect(firstRun.document.translationBatches.every((batch) => batch.status === 'verified')).toBe(true)
    expect(firstRun.pipeline.stages.review.status).toBe('checkpoint')

    const reset = await store.mutate(directory, (draft) => {
      draft.pipeline.stages.translate.status = 'ready'
      draft.pipeline.stages.translate.progress = 0
      delete draft.pipeline.stages.translate.errorCode
      draft.pipeline.stages.review.status = 'pending'
      delete draft.pipeline.stages.review.checkpointId
      delete draft.pipeline.stages.review.errorCode
      delete draft.artifacts.translatedDocument
      delete draft.artifacts.translatedMarkdown
    })
    await store.acquireLease(directory, 'translate', 'f'.repeat(64), undefined, reset.revision)
    const recovered = await store.recoverInterrupted(directory)
    expect(recovered.pipeline.stages.translate.errorCode).toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)

    runProcessMock.mockClear()
    await pipeline.start(directory)

    const completed = await store.load(directory)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(completed.pipeline.stages.translate.status).toBe('completed')
    expect(completed.pipeline.stages.review.status).toBe('checkpoint')
    expect(completed.document.translationBatches.map((batch) => batch.inputFingerprint)).toEqual(originalBatchFingerprints)
    expect(completed.document.translationBatches.every((batch) => batch.status === 'verified')).toBe(true)
    expect(completed.translation.sessionGenerations.find((generation) => generation.id === originalGenerationId)?.status).toBe('lost')
    expect(completed.translation.sessionGenerations.at(-1)).toMatchObject({
      status: 'active',
      reason: 'resume-replacement'
    })
    expect(completed.translation.sessionGenerations.at(-1)?.externalSessionId).toBeUndefined()
    expect(completed.artifacts.translatedDocument.valid).toBe(true)
  })
})

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
vi.mock('../src/main/providers/codex-capability', () => ({
  attestCodexTextOnlyExecutableSnapshot: async () => ({ version: 'codex-cli 1.2.3', sha256: 'a'.repeat(64) }),
  codexTextOnlyExecutableIsSupported: () => true,
  createCodexTextOnlyExecutableSnapshot: async () => ({ directory: '/mock/codex-snapshot-dir', executable: '/mock/codex-snapshot' }),
  removeCodexTextOnlyExecutableSnapshot: async () => undefined
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
  generatedSession = 0
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

function providerResult(text: string, sessionId: string) {
  return {
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: sessionId }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
      })
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

let generatedSession = 0

function providerSessionFromArgs(args: readonly string[]): string {
  const resume = args.indexOf('resume')
  if (resume >= 0) {
    const session = args.slice(resume + 1).find((arg) => /^[0-9a-f-]{36}$/u.test(arg))
    if (session) return session
  }
  generatedSession += 1
  return `019f7e34-385f-7de3-9fac-${String(generatedSession).padStart(12, '0')}`
}

describe('document translation recovery', () => {
  async function translationTask(markdown: string) {
    const directory = await mkdtemp(join(tmpdir(), 'etch-document-boundary-'))
    directories.push(directory)
    const store = new TaskStore()
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://example.com/document-boundary' },
      'Document boundary',
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
        fetchedAt: '2026-08-12T00:00:00.000Z',
        contentType: 'web',
        sourceUrl: 'https://example.com/document-boundary',
        sourceLanguage: 'en'
      },
      blocks: createMarkdownBlocks([{ type: 'paragraph', markdown }]),
      warnings: []
    }
    await writeFile(join(directory, 'source-document.json'), `${JSON.stringify(sourceDocument)}\n`, 'utf8')
    manifest.pipeline.stages.source.status = 'completed'
    manifest.pipeline.stages.inspect.status = 'completed'
    manifest.pipeline.stages.translate.status = 'ready'
    manifest.document.resolvedAction = 'translate'
    manifest.document.resolvedSource = 'web'
    manifest.document.sourceLanguage = 'en'
    manifest.document.blockCount = 1
    manifest.artifacts.sourceDocument = await artifact(directory, 'source-document.json')
    await store.create(directory, manifest)
    return {
      directory,
      store,
      pipeline: new TaskPipeline(
        store,
        defaultSettings('/Users/test'),
        new HistoricalGlossaryService(store, () => []),
        () => undefined
      )
    }
  }

  it('records every Provider call before a translation batch succeeds', async () => {
    const task = await translationTask('A reliable system.')
    let draftCalls = 0
    runProcessMock.mockImplementation(async (spec: { args: string[]; stdin: string }) => {
      const sessionId = providerSessionFromArgs(spec.args)
      if (spec.stdin.includes('document-analysis-blocks')) {
        return providerResult(JSON.stringify({
          contentType: 'article', tone: 'technical', audience: 'developers', glossary: [], risks: []
        }), sessionId)
      }
      const blocks = sectionData(spec.stdin, 'document-blocks')
      draftCalls += 1
      if (draftCalls === 1) return providerResult('not-json', sessionId)
      return providerResult(JSON.stringify({ blocks: blocks.map((block) => ({ id: block.id, markdown: '可靠的系统。' })) }), sessionId)
    })

    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.review.status).toBe('checkpoint')
    expect(completed.document.translationBatches).toEqual([
      expect.objectContaining({ id: 'draft:document-001', status: 'verified', attempt: 2 })
    ])
  })

  it('records Provider calls when a later batch attempt throws', async () => {
    const task = await translationTask('A reliable system.')
    let draftCalls = 0
    runProcessMock.mockImplementation(async (spec: { args: string[]; stdin: string }) => {
      const sessionId = providerSessionFromArgs(spec.args)
      if (spec.stdin.includes('document-analysis-blocks')) {
        return providerResult(JSON.stringify({
          contentType: 'article', tone: 'technical', audience: 'developers', glossary: [], risks: []
        }), sessionId)
      }
      draftCalls += 1
      if (draftCalls === 1) return providerResult('not-json', sessionId)
      throw new Error('provider unavailable')
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('provider unavailable')

    const failed = await task.store.load(task.directory)
    expect(failed.document.translationBatches).toEqual([
      expect.objectContaining({ id: 'draft:document-001', attempt: 2 })
    ])
  })

  it('keeps residual deterministic audit issues as hard failures', async () => {
    const task = await translationTask('Version 2 is stable.')
    runProcessMock.mockImplementation(async (spec: { args: string[]; stdin: string }) => {
      const sessionId = providerSessionFromArgs(spec.args)
      if (spec.stdin.includes('document-analysis-blocks')) {
        return providerResult(JSON.stringify({
          contentType: 'article', tone: 'technical', audience: 'developers', glossary: [], risks: []
        }), sessionId)
      }
      const blocks = sectionData(spec.stdin, 'document-blocks')
      return providerResult(JSON.stringify({ blocks: blocks.map((block) => ({ id: block.id, markdown: '版本 3 很稳定。' })) }), sessionId)
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('文档确定性终检未通过')

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.translate.status).toBe('failed')
    expect(completed.pipeline.stages.review.status).toBe('pending')
    expect(completed.document.warnings).toContain(`${completed.document.translationBatches[0].blockIds[0]}: 数字、日期或单位发生变化`)
    expect(completed.document.translationBatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'audit-repair:document-001', status: 'stale', attempt: 1 })
    ]))
  })

  it('reuses a previously verified draft after a deterministic-only failure without another Provider call', async () => {
    const task = await translationTask('On July 8, 2026, the codebase spans 10+ languages.')
    runProcessMock.mockImplementation(async (spec: { args: string[]; stdin: string }) => {
      const sessionId = providerSessionFromArgs(spec.args)
      if (spec.stdin.includes('document-analysis-blocks')) {
        return providerResult(JSON.stringify({
          contentType: 'article', tone: 'technical', audience: 'developers', glossary: [], risks: []
        }), sessionId)
      }
      const blocks = sectionData(spec.stdin, 'document-blocks')
      return providerResult(JSON.stringify({ blocks: blocks.map((block) => ({
        id: block.id,
        markdown: '2026 年 7 月 8 日，该代码库横跨十多种语言。'
      })) }), sessionId)
    })

    await task.pipeline.start(task.directory)
    const first = await task.store.load(task.directory)
    const draft = first.document.translationBatches.find((batch) => batch.id === 'draft:document-001')
    expect(draft).toMatchObject({ status: 'verified', attempt: 1 })

    const draftText = await readFile(join(task.directory, draft!.artifact!.relativePath), 'utf8')
    const retry = await task.store.mutate(task.directory, (manifest) => {
      manifest.pipeline.stages.translate.status = 'failed'
      manifest.pipeline.stages.translate.errorCode = '文档确定性终检未通过（1 项）'
      manifest.pipeline.stages.review.status = 'pending'
      delete manifest.pipeline.stages.review.checkpointId
      delete manifest.artifacts.translatedDocument
      delete manifest.artifacts.translatedMarkdown
      manifest.document.translationPhase = 'draft'
    })
    runProcessMock.mockReset()

    await task.pipeline.start(task.directory)

    const recovered = await task.store.load(task.directory)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(recovered.pipeline.stages.translate.status).toBe('completed')
    expect(recovered.pipeline.stages.review).toMatchObject({ status: 'checkpoint', checkpointId: 'document-review' })
    expect(recovered.document.translationBatches.find((batch) => batch.id === 'draft:document-001'))
      .toMatchObject({ status: 'verified', attempt: 1 })
    expect(await readFile(join(task.directory, draft!.artifact!.relativePath), 'utf8')).toBe(draftText)
    expect(recovered.revision).toBeGreaterThan(retry.revision)
  })

  it('does not disguise a corrupt source artifact as a translation budget preflight failure', async () => {
    const task = await translationTask('Source text.')
    await writeFile(join(task.directory, 'source-document.json'), '{invalid', 'utf8')

    await expect(task.pipeline.start(task.directory)).rejects.toThrow()

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.translate.status).toBe('failed')
    expect(failed.translation.sessionGenerations).toHaveLength(1)
    expect(failed.translation.sessionGenerations[0]).toMatchObject({ status: 'active', reason: 'initial' })
  })

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
      const sessionId = providerSessionFromArgs(spec.args)
      if (spec.stdin.includes('document-analysis-blocks')) {
        return providerResult(JSON.stringify({
          contentType: 'article',
          tone: 'technical',
          audience: 'developers',
          glossary: [],
          risks: []
        }), sessionId)
      }
      const blocks = sectionData(spec.stdin, 'document-blocks')
      return providerResult(JSON.stringify({
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

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  runProcessMock,
  startProcessMock,
  createCodexTextOnlyExecutableSnapshotMock,
  attestCodexTextOnlyExecutableSnapshotMock,
  codexTextOnlyExecutableIsSupportedMock,
  removeCodexTextOnlyExecutableSnapshotMock,
  codexSnapshotAttestation
} = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  startProcessMock: vi.fn(),
  createCodexTextOnlyExecutableSnapshotMock: vi.fn(async (_executable: string, taskDirectory: string) => ({
    directory: `${taskDirectory}/.codex-text-only-test`,
    executable: `${taskDirectory}/.codex-text-only-test/codex`
  })),
  codexSnapshotAttestation: {
    version: 'codex-cli 0.145.0-alpha.18',
    sha256: '5589325247117acfd2181ec5cf1daad3b88ca46abbeaf6dc43f19c65c07727c6'
  },
  attestCodexTextOnlyExecutableSnapshotMock: vi.fn(async () => ({
    version: 'codex-cli 0.145.0-alpha.18',
    sha256: '5589325247117acfd2181ec5cf1daad3b88ca46abbeaf6dc43f19c65c07727c6'
  })),
  codexTextOnlyExecutableIsSupportedMock: vi.fn(() => true),
  removeCodexTextOnlyExecutableSnapshotMock: vi.fn(async () => undefined)
}))
const fsMockState = vi.hoisted(() => ({ providerLogError: undefined as NodeJS.ErrnoException | undefined }))

vi.mock('../src/main/runtime/process-runner', () => ({
  runProcess: runProcessMock,
  startProcess: startProcessMock,
  settleRegistrationFailure: async (
    running: { cancel(): void; result: Promise<unknown> },
    failure: unknown
  ) => {
    running.cancel()
    try { await running.result } catch { /* preserve durable registration failure */ }
    throw failure
  }
}))
vi.mock('../src/main/runtime/shell-env', () => ({
  loginShellEnvironment: async () => ({ PATH: '/mock' }),
  operationalEnvironment: (env: NodeJS.ProcessEnv) => env,
  providerEnvironment: (_provider: string, env: NodeJS.ProcessEnv) => env,
  logChildEnvironmentKeys: () => undefined
}))
vi.mock('../src/main/providers/codex-capability', () => ({
  createCodexTextOnlyExecutableSnapshot: createCodexTextOnlyExecutableSnapshotMock,
  attestCodexTextOnlyExecutableSnapshot: attestCodexTextOnlyExecutableSnapshotMock,
  codexTextOnlyExecutableIsSupported: codexTextOnlyExecutableIsSupportedMock,
  removeCodexTextOnlyExecutableSnapshot: removeCodexTextOnlyExecutableSnapshotMock
}))
vi.mock('../src/main/runtime/tool-detector', () => ({
  detectTool: async (tool: string) => ({
    tool,
    status: 'ready',
    executable: `/mock/${tool}`,
    version: tool === 'codex' ? 'codex-cli 0.145.0-alpha.18' : 'test',
    summaryZh: `${tool} 可用`
  }),
  identityStillMatches: async () => true,
  toolCacheKey: (tool: string, override?: string) => `${tool}:${override ?? ''}`
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: (...args: unknown[]) => {
      const filename = String(args[0]).split('/').at(-1)
      if (filename?.startsWith('provider-') && fsMockState.providerLogError) {
        return Promise.reject(fsMockState.providerLogError)
      }
      return Reflect.apply(actual.writeFile, actual, args) as ReturnType<typeof actual.writeFile>
    }
  }
})

import { fingerprint, sha256File } from '../src/main/core/fingerprint'
import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { activateSessionGeneration } from '../src/main/pipeline/session-generation'
import {
  PROVIDER_SESSION_CONTAMINATED_PREFIX,
  PROVIDER_SESSION_UNAVAILABLE_PREFIX
} from '../src/main/providers/session-errors'
import { TaskStore } from '../src/main/storage/task-store'
import type { RunRegistry } from '../src/main/runtime/run-registry'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, type TaskManifest } from '../src/shared/task-schema'

const directories: string[] = []

afterEach(async () => {
  runProcessMock.mockReset()
  startProcessMock.mockReset()
  createCodexTextOnlyExecutableSnapshotMock.mockClear()
  attestCodexTextOnlyExecutableSnapshotMock.mockClear()
  codexTextOnlyExecutableIsSupportedMock.mockClear()
  removeCodexTextOnlyExecutableSnapshotMock.mockClear()
  fsMockState.providerLogError = undefined
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

function sourceSrt(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const start = index * 2
    const end = start + 1
    const timestamp = (seconds: number) => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`
    return `${index + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${index === 0 ? 'redis server' : `source cue ${index + 1}`}\n`
  }).join('\n')
}

async function cuesTask(kind: 'manual' | 'automatic' | 'whisper', cueCount = 3, runRegistry?: RunRegistry): Promise<{
  directory: string
  store: TaskStore
  pipeline: TaskPipeline
}> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-english-audit-'))
  directories.push(directory)
  const store = new TaskStore()
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/english-audit' }, 'Technical video', 'codex')
  for (const stage of ['source', 'inspect', 'english'] as const) manifest.pipeline.stages[stage].status = 'completed'
  manifest.pipeline.stages.cues.status = 'ready'
  for (const stage of ['translate', 'audit', 'review', 'srt', 'burn', 'verify'] as const) manifest.pipeline.stages[stage].status = 'skipped'
  manifest.runtime.subtitleKind = kind
  await writeFile(join(directory, 'english.srt'), sourceSrt(cueCount), 'utf8')
  await writeFile(join(directory, 'source.info.json'), JSON.stringify({
    title: 'Technical video',
    channel: 'Engineering',
    description: 'CUDA and kubectl details'
  }), 'utf8')
  manifest.artifacts.english = await artifact(directory, 'english.srt')
  manifest.artifacts.metadata = await artifact(directory, 'source.info.json')
  await store.create(directory, manifest)
  return {
    directory,
    store,
    pipeline: new TaskPipeline(store, defaultSettings('/Users/test'), new HistoricalGlossaryService(store, () => []), () => undefined, runRegistry)
  }
}

function codexSessionId(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function providerStdout(text: unknown, sessionLabel = 'english-session', extras: readonly unknown[] = []): string {
  return [
    { type: 'thread.started', thread_id: codexSessionId(sessionLabel) },
    { type: 'turn.started' },
    ...extras,
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: typeof text === 'string' ? text : JSON.stringify(text) } },
    {
      type: 'turn.completed',
      usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }
    }
  ].map((event) => JSON.stringify(event)).join('\n') + '\n'
}

function providerResult(text: unknown, sessionId = 'english-session') {
  return {
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: providerStdout(text, sessionId),
    stderr: '',
    timedOut: false,
    cancelled: false
  }
}

function translationCueIds(prompt: string | undefined): number[] {
  const envelope = (prompt ?? '').split(/\r?\n/u)
    .find((line) => line.startsWith('{"section":"translation-cues"'))
  if (!envelope) throw new Error('translation-cues prompt section missing')
  const parsed = JSON.parse(envelope) as { data: Array<{ cueId: number }> }
  return parsed.data.map((cue) => cue.cueId)
}

describe('TaskPipeline English source audit', () => {
  it('runs all automatic-caption audit batches serially in one session and atomically applies high-confidence patches', async () => {
    const task = await cuesTask('automatic', 221)
    const args: string[][] = []
    const commands: string[] = []
    let call = 0
    runProcessMock.mockImplementation(async (spec: { command: string; args: string[] }) => {
      commands.push(spec.command)
      args.push(spec.args)
      call += 1
      return providerResult(call === 1 ? {
        patches: [{ cueId: 1, before: 'redis server', after: 'Redis server', reason: '大小写正规化', confidence: 'high' }]
      } : { patches: [] })
    })

    await task.pipeline.start(task.directory)

    const manifest = await task.store.load(task.directory)
    expect(manifest.pipeline.stages.cues.status).toBe('completed')
    expect(manifest.translation.sessionGenerations).toHaveLength(1)
    expect(manifest.translation.sessionGenerations[0].externalSessionId).toBe(codexSessionId('english-session'))
    expect(args).toHaveLength(2)
    expect(commands).toEqual(Array(2).fill(join(task.directory, '.codex-text-only-test', 'codex')))
    expect(commands).not.toContain('/mock/codex')
    expect(createCodexTextOnlyExecutableSnapshotMock).toHaveBeenCalledTimes(2)
    expect(attestCodexTextOnlyExecutableSnapshotMock).toHaveBeenCalledTimes(4)
    expect(removeCodexTextOnlyExecutableSnapshotMock).toHaveBeenCalledTimes(2)
    expect(args[0].join(' ')).not.toContain('resume')
    expect(args[1].join(' ')).toContain('resume')
    expect(args[1]).toContain(codexSessionId('english-session'))
    expect(await readFile(join(task.directory, manifest.artifacts.english.relativePath), 'utf8')).toContain('redis server')
    expect(await readFile(join(task.directory, manifest.artifacts.englishClean.relativePath), 'utf8')).toContain('Redis server')
    expect(await readFile(join(task.directory, 'english.clean.srt'), 'utf8'))
      .toBe(await readFile(join(task.directory, manifest.artifacts.englishClean.relativePath), 'utf8'))
    expect(await readFile(join(task.directory, 'en_cues.tsv'), 'utf8'))
      .toBe(await readFile(join(task.directory, manifest.artifacts.englishCues.relativePath), 'utf8'))
    expect(manifest.artifacts.englishClean.producer).toBe('english-source-audit-v1')
    expect(manifest.artifacts.englishCues.producer).toBe('english-source-audit-v1')
    expect(manifest.artifacts.englishSourceAudit.valid).toBe(true)
  })

  it('durably resumes the first audit session after a later batch fails and the cues stage is retried', async () => {
    const task = await cuesTask('automatic', 221)
    const args: string[][] = []
    let call = 0
    runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
      args.push(spec.args)
      call += 1
      if (call === 2) {
        return {
          ...providerResult({ patches: [] }, 'durable-english-session'),
          exitCode: 9,
          stderr: ''
        }
      }
      return providerResult({ patches: [] }, 'durable-english-session')
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('codex \u6ca1\u6709\u8fd4\u56de\u6709\u6548\u7ed3\u679c')

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.cues).toMatchObject({ status: 'failed', attempt: 1 })
    expect(failed.translation.sessionGenerations).toHaveLength(1)
    expect(failed.translation.sessionGenerations[0].externalSessionId).toBe(codexSessionId('durable-english-session'))

    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.cues).toMatchObject({ status: 'completed', attempt: 2 })
    expect(completed.translation.sessionGenerations).toHaveLength(1)
    expect(completed.translation.sessionGenerations[0].externalSessionId).toBe(codexSessionId('durable-english-session'))
    expect(args).toHaveLength(4)
    expect(args[0].join(' ')).not.toContain('resume')
    expect(args.slice(1).every((invocation) => invocation.join(' ').includes('resume'))).toBe(true)
    expect(args.slice(1).every((invocation) => invocation.includes(codexSessionId('durable-english-session')))).toBe(true)
  })

  it('uses a fresh replacement session after startup recovers an interrupted provider call', async () => {
    const task = await cuesTask('automatic')
    const oldSessionId = codexSessionId('interrupted-provider-session')
    let generationId = ''
    await task.store.mutate(task.directory, (manifest) => {
      const generation = activateSessionGeneration(
        manifest,
        'codex',
        { source: 'cli-default' },
        task.directory,
        'initial'
      )
      generation.externalSessionId = oldSessionId
      generationId = generation.id
    })
    await task.store.acquireLease(
      task.directory,
      'cues',
      fingerprint('interrupted-cues', 1, { generationId })
    )

    const recovered = await task.store.recoverInterrupted(task.directory)
    expect(recovered.pipeline.stages.cues.errorCode).toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)

    runProcessMock.mockResolvedValue(providerResult({ patches: [] }, 'fresh-after-recovery'))
    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.cues.status).toBe('completed')
    expect(completed.translation.sessionGenerations).toHaveLength(2)
    expect(completed.translation.sessionGenerations[0]).toMatchObject({
      id: generationId,
      externalSessionId: oldSessionId,
      status: 'lost'
    })
    expect(completed.translation.sessionGenerations[1]).toMatchObject({
      externalSessionId: codexSessionId('fresh-after-recovery'),
      reason: 'resume-replacement',
      status: 'active'
    })
    const args = runProcessMock.mock.calls[0]?.[0]?.args as string[]
    expect(args.join(' ')).not.toContain('resume')
    expect(args).not.toContain(oldSessionId)
  })

  it('replaces a terminally lost session only on the next explicit start', async () => {
    const task = await cuesTask('automatic')
    await task.store.mutate(task.directory, (manifest) => {
      const generation = activateSessionGeneration(
        manifest,
        'codex',
        { source: 'cli-default' },
        task.directory,
        'initial'
      )
      generation.externalSessionId = codexSessionId('missing-session')
      manifest.pipeline.stages.cues.status = 'failed'
      manifest.pipeline.stages.cues.errorCode = `${PROVIDER_SESSION_UNAVAILABLE_PREFIX}rollout not found`
    })
    const args: string[][] = []
    runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
      args.push(spec.args)
      return providerResult({ patches: [] }, 'replacement-session')
    })

    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.cues).toMatchObject({ status: 'completed', attempt: 1 })
    expect(completed.translation.sessionGenerations).toHaveLength(2)
    expect(completed.translation.sessionGenerations[0]).toMatchObject({
      status: 'lost',
      reason: 'initial',
      externalSessionId: codexSessionId('missing-session')
    })
    expect(completed.translation.sessionGenerations[1]).toMatchObject({
      status: 'active',
      reason: 'resume-replacement',
      externalSessionId: codexSessionId('replacement-session')
    })
    expect(args).toHaveLength(1)
    expect(args[0].join(' ')).not.toContain(' resume ')
  })

  it('records terminal resume loss without replacing the session during the failing start', async () => {
    const task = await cuesTask('automatic')
    await task.store.mutate(task.directory, (manifest) => {
      const generation = activateSessionGeneration(
        manifest,
        'codex',
        { source: 'cli-default' },
        task.directory,
        'initial'
      )
      generation.externalSessionId = codexSessionId('expired-session')
    })
    runProcessMock.mockResolvedValue({
      pid: 1,
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: `No saved session found with id ${codexSessionId('expired-session')}`,
      timedOut: false,
      cancelled: false
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow(PROVIDER_SESSION_UNAVAILABLE_PREFIX)

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.cues).toMatchObject({
      status: 'failed',
      errorCode: expect.stringContaining(PROVIDER_SESSION_UNAVAILABLE_PREFIX)
    })
    expect(failed.translation.sessionGenerations).toHaveLength(1)
    expect(failed.translation.sessionGenerations[0]).toMatchObject({
      status: 'active',
      reason: 'initial',
      externalSessionId: codexSessionId('expired-session')
    })
  })

  it('does not rotate a session that was successfully observed before a later provider failure', async () => {
    const task = await cuesTask('automatic')
    await task.store.mutate(task.directory, (manifest) => {
      const generation = activateSessionGeneration(
        manifest,
        'codex',
        { source: 'cli-default' },
        task.directory,
        'initial'
      )
      generation.externalSessionId = codexSessionId('observed-session')
    })
    const args: string[][] = []
    runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
      args.push(spec.args)
      return {
        pid: 1,
        exitCode: 1,
        signal: null,
        stdout: providerStdout({ patches: [] }, 'observed-session'),
        stderr: '',
        timedOut: false,
        cancelled: false
      }
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('codex 没有返回有效结果')
    await expect(task.pipeline.start(task.directory)).rejects.toThrow('codex 没有返回有效结果')

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.cues.errorCode).not.toContain(PROVIDER_SESSION_UNAVAILABLE_PREFIX)
    expect(failed.translation.sessionGenerations).toHaveLength(1)
    expect(failed.translation.sessionGenerations[0]).toMatchObject({
      status: 'active',
      externalSessionId: codexSessionId('observed-session')
    })
    expect(args).toHaveLength(2)
    expect(args.every((invocation) => invocation.includes(codexSessionId('observed-session')))).toBe(true)
  })

  it('persists a newly observed provider session before the provider process completes', async () => {
    const task = await cuesTask('automatic')
    let persistedBeforeCompletion = false
    runProcessMock.mockImplementation(async (spec: { onStdout?: (chunk: string) => void }) => {
      const sessionLine = `${JSON.stringify({ type: 'thread.started', thread_id: codexSessionId('streamed-session') })}\n`
      spec.onStdout?.(sessionLine)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const manifest = await task.store.load(task.directory)
        if (manifest.translation.sessionGenerations[0]?.externalSessionId === codexSessionId('streamed-session')) {
          persistedBeforeCompletion = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const completed = providerResult({ patches: [] }, 'streamed-session')
      spec.onStdout?.(completed.stdout.slice(sessionLine.length))
      return completed
    })

    await task.pipeline.start(task.directory)

    expect(persistedBeforeCompletion).toBe(true)
    expect((await task.store.load(task.directory)).translation.sessionGenerations[0].externalSessionId)
      .toBe(codexSessionId('streamed-session'))
  })

  it('reuses the English-audit session for the following translation stage', async () => {
    const task = await cuesTask('automatic')
    const before = await task.store.load(task.directory)
    before.pipeline.stages.translate.status = 'ready'
    await task.store.create(task.directory, before)
    const calls: Array<{ args: string[]; stdin?: string }> = []
    runProcessMock.mockImplementation(async (spec: { args: string[]; stdin?: string }) => {
      calls.push({ args: spec.args, stdin: spec.stdin })
      return providerResult(spec.stdin?.includes('英文源字幕的 ASR 准确性')
        ? { patches: [] }
        : '1\t译文一\n2\t译文二\n3\t译文三\n')
    })

    await task.pipeline.start(task.directory)

    const manifest = await task.store.load(task.directory)
    expect(manifest.pipeline.stages.translate.status).toBe('completed')
    expect(calls).toHaveLength(2)
    expect(calls[1].args.join(' ')).toContain('resume')
    expect(calls[1].args).toContain(codexSessionId('english-session'))
    expect(await readFile(join(task.directory, manifest.artifacts.chineseCues.relativePath), 'utf8'))
      .toBe('1\t译文一\n2\t译文二\n3\t译文三\n')
  })

  it('durably resumes a manual-subtitle translation session after a later batch fails', async () => {
    const task = await cuesTask('manual', 151)
    const before = await task.store.load(task.directory)
    before.pipeline.stages.translate.status = 'ready'
    await task.store.create(task.directory, before)
    const args: string[][] = []
    let call = 0
    runProcessMock.mockImplementation(async (spec: { args: string[]; stdin?: string }) => {
      args.push(spec.args)
      call += 1
      if (call === 2) {
        return {
          ...providerResult('ignored', 'durable-translation-session'),
          exitCode: 9,
          stderr: ''
        }
      }
      const output = `${translationCueIds(spec.stdin).map((cueId) => `${cueId}\t译文`).join('\n')}\n`
      return providerResult(output, 'durable-translation-session')
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('codex 没有返回有效结果')

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.translate).toMatchObject({ status: 'failed', attempt: 1 })
    expect(failed.translation.sessionGenerations[0].externalSessionId).toBe(codexSessionId('durable-translation-session'))
    expect(failed.translation.batches[0]).toMatchObject({
      id: 'batch-001',
      status: 'verified',
      artifact: expect.objectContaining({ valid: true })
    })
    expect(await readFile(join(task.directory, failed.translation.batches[0].artifact!.relativePath), 'utf8')).toContain('1\t译文')

    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.translate).toMatchObject({ status: 'completed', attempt: 2 })
    expect(completed.translation.sessionGenerations[0].externalSessionId).toBe(codexSessionId('durable-translation-session'))
    // 第一个已验证批次从 manifest 内联 artifact 恢复，重试只调用剩余三批。
    expect(args).toHaveLength(5)
    expect(args[0].join(' ')).not.toContain('resume')
    expect(args.slice(1).every((invocation) => invocation.join(' ').includes('resume'))).toBe(true)
    expect(args.slice(1).every((invocation) => invocation.includes(codexSessionId('durable-translation-session')))).toBe(true)
  })

  it('reuses every verified translation batch after recoverInterrupted replaces the Provider generation', async () => {
    const task = await cuesTask('manual', 151)
    const before = await task.store.load(task.directory)
    before.pipeline.stages.translate.status = 'ready'
    await task.store.create(task.directory, before)
    runProcessMock.mockImplementation(async (spec: { stdin?: string }) => providerResult(
      `${translationCueIds(spec.stdin).map((cueId) => `${cueId}\t译文`).join('\n')}\n`,
      'before-restart-session'
    ))

    await task.pipeline.start(task.directory)

    const firstRun = await task.store.load(task.directory)
    const originalGenerationId = firstRun.translation.activeGenerationId
    const originalBatchFingerprints = firstRun.translation.batches.map((batch) => batch.inputFingerprint)
    expect(firstRun.translation.batches).toHaveLength(4)
    expect(firstRun.translation.batches.every((batch) => batch.status === 'verified')).toBe(true)

    const reset = await task.store.mutate(task.directory, (manifest) => {
      manifest.pipeline.stages.translate.status = 'ready'
      manifest.pipeline.stages.translate.progress = 0
      delete manifest.pipeline.stages.translate.errorCode
      delete manifest.artifacts.translationGlossary
      delete manifest.artifacts.chineseCues
    })
    await task.store.acquireLease(task.directory, 'translate', 'f'.repeat(64), undefined, reset.revision)
    const recovered = await task.store.recoverInterrupted(task.directory)
    expect(recovered.pipeline.stages.translate.errorCode).toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)

    runProcessMock.mockClear()
    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(completed.pipeline.stages.translate.status).toBe('completed')
    expect(completed.translation.batches.map((batch) => batch.inputFingerprint)).toEqual(originalBatchFingerprints)
    expect(completed.translation.batches.every((batch) => batch.status === 'verified')).toBe(true)
    expect(completed.translation.sessionGenerations.find((generation) => generation.id === originalGenerationId)?.status).toBe('lost')
    expect(completed.translation.sessionGenerations.at(-1)).toMatchObject({
      status: 'active',
      reason: 'resume-replacement'
    })
    expect(completed.translation.sessionGenerations.at(-1)?.externalSessionId).toBeUndefined()
  })

  it('checkpoints more than 800 cues before any translation Provider call', async () => {
    const task = await cuesTask('manual', 801)
    const before = await task.store.load(task.directory)
    before.pipeline.stages.translate.status = 'ready'
    await task.store.create(task.directory, before)

    await task.pipeline.start(task.directory)

    const checkpoint = await task.store.load(task.directory)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(checkpoint.pipeline.stages.translate).toMatchObject({
      status: 'checkpoint',
      checkpointId: checkpoint.video.checkpoint?.checkpointId
    })
    expect(checkpoint.video.checkpoint).toMatchObject({
      kind: 'large-translation',
      stage: 'translate',
      metrics: { cueCount: 801, batchCount: expect.any(Number) }
    })
    expect(checkpoint.translation.batches.length).toBeGreaterThan(1)

    const accepted = await task.pipeline.resolveVideoCheckpoint(task.directory, checkpoint.revision, 'accept')
    expect(accepted.pipeline.stages.translate.status).toBe('ready')
    expect(accepted.video.decisions.at(-1)).toMatchObject({ kind: 'large-translation', decision: 'accept' })
  })

  it('stops at an English ambiguity checkpoint and resolves every decision into immutable corrected artifacts', async () => {
    const task = await cuesTask('whisper')
    const before = await task.store.load(task.directory)
    before.pipeline.stages.translate.status = 'pending'
    await task.store.create(task.directory, before)
    runProcessMock.mockResolvedValue(providerResult({
      patches: [{ cueId: 2, before: 'source cue 2', after: 'source queue 2', reason: '需结合音频', confidence: 'ambiguous' }]
    }))

    await task.pipeline.start(task.directory)

    const checkpoint = await task.store.load(task.directory)
    expect(checkpoint.pipeline.stages.cues).toMatchObject({ status: 'checkpoint', checkpointId: 'english-source-ambiguity' })
    expect(checkpoint.pipeline.stages.translate.status).toBe('pending')
    expect(checkpoint.translation.auditCheckpoint?.ambiguities[0]).toMatchObject({
      cueId: 2,
      before: 'source cue 2',
      startMs: 2_000,
      endMs: 3_000
    })
    const checkpointSrt = checkpoint.artifacts.englishClean.relativePath
    const checkpointFingerprint = checkpoint.artifacts.englishClean.inputFingerprint

    const resolved = await task.pipeline.resolveAudit(task.directory, [{ cueId: 2, translation: 'source queue 2' }])

    expect(resolved.pipeline.stages.cues.status).toBe('completed')
    expect(resolved.pipeline.stages.translate.status).toBe('ready')
    expect(resolved.translation.auditCheckpoint).toBeUndefined()
    expect(resolved.artifacts.englishClean.relativePath).not.toBe(checkpointSrt)
    expect(resolved.artifacts.englishClean.producer).toBe('user-english-source-decision')
    expect(resolved.artifacts.englishClean.inputFingerprint).not.toBe(checkpointFingerprint)
    expect(resolved.artifacts.englishClean.inputFingerprint).toBe(resolved.artifacts.englishCues.inputFingerprint)
    expect(resolved.artifacts.englishClean.inputFingerprint).toBe(resolved.artifacts.englishSourceAudit.inputFingerprint)
    expect(await readFile(join(task.directory, resolved.artifacts.englishClean.relativePath), 'utf8')).toContain('source queue 2')
    expect(await readFile(join(task.directory, 'english.clean.srt'), 'utf8'))
      .toBe(await readFile(join(task.directory, resolved.artifacts.englishClean.relativePath), 'utf8'))
    expect(await readFile(join(task.directory, 'en_cues.tsv'), 'utf8'))
      .toBe(await readFile(join(task.directory, resolved.artifacts.englishCues.relativePath), 'utf8'))
    const resolution = JSON.parse(await readFile(join(task.directory, resolved.artifacts.englishSourceAudit.relativePath), 'utf8')) as { resolutions: unknown[] }
    expect(resolution.resolutions).toHaveLength(1)
  })

  it('rejects duplicate English checkpoint decisions before replacing any artifact', async () => {
    const task = await cuesTask('automatic', 20)
    runProcessMock.mockResolvedValue(providerResult({
      patches: [
        { cueId: 2, before: 'source cue 2', after: 'revised second line', reason: '需结合音频', confidence: 'ambiguous' },
        { cueId: 4, before: 'source cue 4', after: 'revised fourth line', reason: '需结合音频', confidence: 'ambiguous' }
      ]
    }))
    await task.pipeline.start(task.directory)
    const checkpoint = await task.store.load(task.directory)

    await expect(task.pipeline.resolveAudit(task.directory, [
      { cueId: 2, translation: 'first decision' },
      { cueId: 2, translation: 'duplicate decision' }
    ])).rejects.toThrow('必须一次解决当前全部英文源字幕歧义')

    const unchanged = await task.store.load(task.directory)
    expect(unchanged.revision).toBe(checkpoint.revision)
    expect(unchanged.pipeline.stages.cues.status).toBe('checkpoint')
    expect(unchanged.artifacts.englishClean.relativePath).toBe(checkpoint.artifacts.englishClean.relativePath)
  })

  it('fails closed when the committed raw English artifact changes on disk', async () => {
    const task = await cuesTask('automatic')
    await writeFile(join(task.directory, 'english.srt'), sourceSrt(3).replace('redis server', 'tampered cue 1'), 'utf8')

    await expect(task.pipeline.start(task.directory)).rejects.toThrow(/英文源字幕产物.*不匹配/u)

    const manifest = await task.store.load(task.directory)
    expect(manifest.pipeline.stages.cues.status).toBe('failed')
    expect(manifest.artifacts.englishClean).toBeUndefined()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('fails closed when the committed metadata artifact changes on disk', async () => {
    const task = await cuesTask('automatic')
    await writeFile(join(task.directory, 'source.info.json'), '{"title":"tampered"}\n', 'utf8')

    await expect(task.pipeline.start(task.directory)).rejects.toThrow(/视频 metadata.*不匹配/u)

    const manifest = await task.store.load(task.directory)
    expect(manifest.pipeline.stages.cues.status).toBe('failed')
    expect(manifest.artifacts.englishClean).toBeUndefined()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('rejects and replaces a Codex session that attempted any tool call', async () => {
    const task = await cuesTask('automatic')
    const toolRun = {
      pid: 1,
      exitCode: 0,
      signal: null,
      stdout: providerStdout({ patches: [] }, 'tool-session', [
        { type: 'item.started', item: { type: 'web_search', query: 'file:///private' } }
      ]),
      stderr: '',
      timedOut: false,
      cancelled: false
    }
    runProcessMock.mockImplementationOnce(async (spec: { onStdout?: (chunk: string) => void }) => {
      spec.onStdout?.(toolRun.stdout)
      return toolRun
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('尝试调用工具：web_search')

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.cues).toMatchObject({
      status: 'failed',
      errorCode: expect.stringContaining(PROVIDER_SESSION_CONTAMINATED_PREFIX)
    })
    expect(failed.translation.sessionGenerations[0]).toMatchObject({
      status: 'active',
      externalSessionId: codexSessionId('tool-session')
    })
    expect(failed.artifacts.englishClean).toBeUndefined()

    runProcessMock.mockResolvedValue(providerResult({ patches: [] }, 'replacement-session'))
    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.cues.status).toBe('completed')
    expect(completed.translation.sessionGenerations).toHaveLength(2)
    expect(completed.translation.sessionGenerations[0]).toMatchObject({
      status: 'lost',
      externalSessionId: codexSessionId('tool-session')
    })
    expect(completed.translation.sessionGenerations[1]).toMatchObject({
      status: 'active',
      reason: 'resume-replacement',
      externalSessionId: codexSessionId('replacement-session')
    })
    const replacementArgs = runProcessMock.mock.calls.at(-1)?.[0]?.args as string[]
    expect(replacementArgs).not.toContain(codexSessionId('tool-session'))
  })

  it('registers a real-app text-only process and preserves contamination when registry cleanup also fails', async () => {
    const register = vi.fn(async (record: unknown) => { void record })
    const finish = vi.fn(async (runId: string) => { void runId; throw new Error('registry finish failed') })
    const runRegistry = { register, finish } as unknown as RunRegistry
    const task = await cuesTask('automatic', 3, runRegistry)
    const toolRun = {
      ...providerResult({ patches: [] }, 'registered-tool-session'),
      stderr: 'ERROR codex_core::tools::router: error=apply_patch verification failed'
    }
    startProcessMock.mockImplementation((spec: { onStdout?: (chunk: string) => void }) => {
      spec.onStdout?.(toolRun.stdout)
      return { pid: 43210, executable: join(task.directory, '.codex-text-only-test', 'codex'), result: Promise.resolve(toolRun), cancel: vi.fn() }
    })
    const cleanupLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(task.pipeline.start(task.directory)).rejects.toThrow('纯文本阶段尝试调用工具：apply_patch')

      expect(runProcessMock).not.toHaveBeenCalled()
      expect(register).toHaveBeenCalledWith(expect.objectContaining({
        pid: 43210,
        pgid: 43210,
        executable: join(task.directory, '.codex-text-only-test', 'codex'),
        taskId: (await task.store.load(task.directory)).taskId,
        stage: 'cues'
      }))
      expect(finish).toHaveBeenCalledWith((register.mock.calls[0][0] as { runId: string }).runId)
      expect(cleanupLog).toHaveBeenCalledWith('Provider 进程登记清理失败', expect.any(Error))
      expect((await task.store.load(task.directory)).pipeline.stages.cues.errorCode)
        .toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)
    } finally {
      cleanupLog.mockRestore()
    }
  })

  it.each(['ENOSPC', 'EACCES'] as const)('preserves contamination when the provider log write fails with %s', async (code) => {
    const task = await cuesTask('automatic')
    const contaminated = {
      ...providerResult({ patches: [] }, `log-failure-${code.toLowerCase()}-session`),
      stderr: 'ERROR codex_core::tools::router: error=apply_patch verification failed'
    }
    runProcessMock.mockResolvedValue(contaminated)
    fsMockState.providerLogError = Object.assign(new Error(`provider log ${code}`), { code })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(task.pipeline.start(task.directory)).rejects.toThrow('纯文本阶段尝试调用工具：apply_patch')

      expect(errorLog).toHaveBeenCalledWith('Provider 日志写入失败', expect.objectContaining({ code }))
      expect((await task.store.load(task.directory)).pipeline.stages.cues.errorCode)
        .toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('preserves a provider execution failure when the provider log write fails with ENOSPC', async () => {
    const task = await cuesTask('automatic')
    runProcessMock.mockResolvedValue({
      ...providerResult({ patches: [] }, 'execution-failure-log-enospc-session'),
      exitCode: 9
    })
    fsMockState.providerLogError = Object.assign(new Error('provider log ENOSPC'), { code: 'ENOSPC' })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(task.pipeline.start(task.directory)).rejects.toThrow('codex 没有返回有效结果')

      expect(errorLog).toHaveBeenCalledWith('Provider 日志写入失败', expect.objectContaining({ code: 'ENOSPC' }))
      expect((await task.store.load(task.directory)).pipeline.stages.cues.errorCode)
        .toContain('codex 没有返回有效结果')
    } finally {
      errorLog.mockRestore()
    }
  })

  it.each([
    {
      label: 'timeout',
      result: { exitCode: 143, signal: null, timedOut: true, timeoutReason: 'wall-clock', cancelled: false },
      expected: 'opencode 调用超时'
    },
    {
      label: 'cancellation',
      result: { exitCode: null, signal: 'SIGTERM', timedOut: false, cancelled: true },
      expected: 'opencode 调用已取消'
    },
    {
      label: 'signal',
      result: { exitCode: null, signal: 'SIGKILL', timedOut: false, cancelled: false },
      expected: 'opencode 没有返回有效结果'
    }
  ])('reports an empty provider $label as an execution failure instead of session contamination', async ({ result, expected }) => {
    const task = await cuesTask('automatic')
    await task.store.mutate(task.directory, (manifest) => {
      manifest.translation.selectedProvider = 'opencode'
    })
    runProcessMock.mockResolvedValue({
      pid: 1,
      stdout: '',
      stderr: '',
      ...result
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow(expected)

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.cues.errorCode).toContain(expected)
    expect(failed.pipeline.stages.cues.errorCode).not.toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)
  })

  it.each([
    {
      label: 'non-UUID session',
      stdout: providerStdout({ patches: [] }, 'invalid-session')
        .replace(codexSessionId('invalid-session'), 'not-a-uuid'),
      persistedSessionId: undefined
    },
    {
      label: 'multiple sessions',
      stdout: providerStdout(
        { patches: [] },
        'first-session',
        [{ type: 'thread.started', thread_id: codexSessionId('second-session') }]
      ),
      persistedSessionId: codexSessionId('first-session')
    }
  ])('keeps $label contamination above a simultaneous execution failure', async ({ stdout, persistedSessionId }) => {
    const task = await cuesTask('automatic')
    runProcessMock.mockResolvedValue({
      pid: 1,
      exitCode: 9,
      signal: null,
      stdout,
      stderr: '',
      timedOut: false,
      cancelled: false
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow(PROVIDER_SESSION_CONTAMINATED_PREFIX)

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.cues.errorCode).toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)
    if (persistedSessionId) {
      expect(failed.translation.sessionGenerations[0].externalSessionId).toBe(persistedSessionId)
    } else {
      expect(failed.translation.sessionGenerations[0]).not.toHaveProperty('externalSessionId')
    }
  })

  it('does not persist an observed session when durable registration fails and rotates on the next start', async () => {
    const register = vi.fn()
      .mockRejectedValueOnce(new Error('registry register failed'))
      .mockResolvedValueOnce(undefined)
    const finish = vi.fn(async (runId: string) => { void runId })
    const runRegistry = { register, finish } as unknown as RunRegistry
    const task = await cuesTask('automatic', 3, runRegistry)
    const persistSession = vi.spyOn(task.store, 'persistLeaseExternalSession')
    const firstRun = providerResult({ patches: [] }, 'unregistered-observed-session')
    const secondRun = providerResult({ patches: [] }, 'registered-replacement-session')
    const cancels = [vi.fn(), vi.fn()]
    startProcessMock.mockImplementation((spec: { onStdout?: (chunk: string) => void }) => {
      const index = startProcessMock.mock.calls.length - 1
      const run = index === 0 ? firstRun : secondRun
      spec.onStdout?.(run.stdout)
      return {
        pid: 54321 + index,
        executable: join(task.directory, '.codex-text-only-test', 'codex'),
        result: Promise.resolve(run),
        cancel: cancels[index]
      }
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow(
      `${PROVIDER_SESSION_CONTAMINATED_PREFIX}codex text-only 进程持久登记失败：registry register failed`
    )

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.cues.errorCode).toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)
    expect(failed.translation.sessionGenerations).toHaveLength(1)
    expect(failed.translation.sessionGenerations[0].status).toBe('active')
    expect(failed.translation.sessionGenerations[0]).not.toHaveProperty('externalSessionId')
    expect(persistSession).not.toHaveBeenCalled()
    expect(cancels[0]).toHaveBeenCalledTimes(1)
    expect(finish).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()

    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.cues.status).toBe('completed')
    expect(completed.translation.sessionGenerations).toHaveLength(2)
    expect(completed.translation.sessionGenerations[0].status).toBe('lost')
    expect(completed.translation.sessionGenerations[0]).not.toHaveProperty('externalSessionId')
    expect(completed.translation.sessionGenerations[1]).toMatchObject({
      status: 'active',
      reason: 'resume-replacement',
      externalSessionId: codexSessionId('registered-replacement-session')
    })
    expect(register).toHaveBeenCalledTimes(2)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(persistSession).toHaveBeenCalledTimes(1)
  })

  it('fails closed and rotates after arbitrary Codex text-only stderr', async () => {
    const task = await cuesTask('automatic')
    runProcessMock.mockResolvedValueOnce({
      ...providerResult({ patches: [] }, 'stderr-contaminated-session'),
      stderr: 'ordinary provider diagnostic'
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('Codex stderr line 1: unapproved stderr diagnostic')

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.cues.errorCode).toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)

    runProcessMock.mockResolvedValueOnce(providerResult({ patches: [] }, 'stderr-replacement-session'))
    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.translation.sessionGenerations).toHaveLength(2)
    expect(completed.translation.sessionGenerations[0]).toMatchObject({ status: 'lost' })
    expect(completed.translation.sessionGenerations[1]).toMatchObject({
      status: 'active',
      reason: 'resume-replacement',
      externalSessionId: codexSessionId('stderr-replacement-session')
    })
  })

  it('accepts bounded Codex connection-reset and timeout retries after HTTPS fallback succeeds', async () => {
    const task = await cuesTask('automatic')
    const extras = [
      {
        type: 'error',
        message: [
          'Reconnecting... 2/5 (unexpected status 403 Forbidden: 19e9\r',
          '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head></html>',
          ', url: wss://chatgpt.com/backend-api/codex/responses, cf-ray: a21ac1855b1d0a9d-SIN)'
        ].join('\n')
      },
      {
        type: 'error',
        message: 'Reconnecting... 3/5 (stream disconnected before completion: Connection reset by peer (os error 54))'
      },
      {
        type: 'error',
        message: 'Reconnecting... 4/5 (request timed out)'
      },
      {
        type: 'error',
        message: 'Reconnecting... 5/5 (stream disconnected before completion: Connection reset by peer (os error 54))'
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'error',
          message: 'Falling back from WebSockets to HTTPS transport. stream disconnected before completion: Connection reset by peer (os error 54)'
        }
      }
    ]
    runProcessMock.mockResolvedValue({
      ...providerResult({ patches: [] }, 'connection-reset-session'),
      stdout: providerStdout({ patches: [] }, 'connection-reset-session', extras),
      stderr: [
        '2026-07-23T02:33:33.313351Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: Connection reset by peer (os error 54), url: wss://chatgpt.com/backend-api/codex/responses',
        '2026-07-23T02:33:42.096257Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: Connection reset by peer (os error 54), url: wss://chatgpt.com/backend-api/codex/responses'
      ].join('\n')
    })

    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.cues.status).toBe('completed')
    expect(completed.translation.sessionGenerations).toHaveLength(1)
    expect(completed.translation.sessionGenerations[0]).toMatchObject({
      status: 'active',
      externalSessionId: codexSessionId('connection-reset-session')
    })
  })

  it('preserves the provider security failure when failLease cannot persist it with ENOSPC', async () => {
    const task = await cuesTask('automatic')
    runProcessMock.mockResolvedValue({
      ...providerResult({ patches: [] }, 'fail-lease-enospc-session'),
      stderr: 'ERROR codex_core::tools::router: error=apply_patch verification failed'
    })
    const stateFailure = Object.assign(new Error('task state ENOSPC'), { code: 'ENOSPC' })
    vi.spyOn(task.store, 'failLease').mockRejectedValueOnce(stateFailure)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(task.pipeline.start(task.directory)).rejects.toThrow('纯文本阶段尝试调用工具：apply_patch')
      expect(errorLog).toHaveBeenCalledWith('流水线失败状态持久化失败', stateFailure)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('finishes the durable process record after a successful text-only provider call', async () => {
    const register = vi.fn(async (record: unknown) => { void record })
    const finish = vi.fn(async (runId: string) => { void runId })
    const runRegistry = { register, finish } as unknown as RunRegistry
    const task = await cuesTask('automatic', 3, runRegistry)
    const cleanRun = providerResult({ patches: [] }, 'registered-clean-session')
    startProcessMock.mockImplementation((spec: { onStdout?: (chunk: string) => void }) => {
      spec.onStdout?.(cleanRun.stdout)
      return { pid: 65432, executable: join(task.directory, '.codex-text-only-test', 'codex'), result: Promise.resolve(cleanRun), cancel: vi.fn() }
    })

    await task.pipeline.start(task.directory)

    expect((await task.store.load(task.directory)).pipeline.stages.cues.status).toBe('completed')
    expect(register).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledWith((register.mock.calls[0][0] as { runId: string }).runId)
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('taints a session when the private Codex snapshot changes during a text-only call and removes it', async () => {
    const task = await cuesTask('automatic')
    attestCodexTextOnlyExecutableSnapshotMock
      .mockResolvedValueOnce(codexSnapshotAttestation)
      .mockResolvedValueOnce({ ...codexSnapshotAttestation, sha256: '0'.repeat(64) })
    runProcessMock.mockResolvedValue(providerResult({ patches: [] }, 'binary-drift-session'))

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('私有快照在纯文本调用期间发生变化')

    const failed = await task.store.load(task.directory)
    expect(failed.pipeline.stages.cues).toMatchObject({
      status: 'failed',
      errorCode: expect.stringContaining(PROVIDER_SESSION_CONTAMINATED_PREFIX)
    })
    expect(failed.artifacts.englishClean).toBeUndefined()
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(removeCodexTextOnlyExecutableSnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('removes the private Codex snapshot when its identity format is invalid', async () => {
    const task = await cuesTask('automatic')
    codexTextOnlyExecutableIsSupportedMock.mockReturnValueOnce(false)

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('快照身份格式无效')

    expect(runProcessMock).not.toHaveBeenCalled()
    expect(attestCodexTextOnlyExecutableSnapshotMock).toHaveBeenCalledTimes(1)
    expect(removeCodexTextOnlyExecutableSnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('removes the private Codex snapshot when provider execution throws', async () => {
    const task = await cuesTask('automatic')
    runProcessMock.mockRejectedValue(new Error('spawn failed'))

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('spawn failed')

    expect(removeCodexTextOnlyExecutableSnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a translation response with a stderr-only tool attempt and retries in a fresh session', async () => {
    const task = await cuesTask('manual')
    await task.store.mutate(task.directory, (manifest) => {
      manifest.pipeline.stages.translate.status = 'ready'
    })
    runProcessMock.mockResolvedValue({
      pid: 1,
      exitCode: 0,
      signal: null,
      stdout: providerStdout('1\t译文一\n2\t译文二\n3\t译文三\n', 'translation-tool-session'),
      stderr: 'ERROR codex_core::tools::router: error=apply_patch verification failed',
      timedOut: false,
      cancelled: false
    })

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('纯文本阶段尝试调用工具：apply_patch')

    const manifest = await task.store.load(task.directory)
    expect(manifest.pipeline.stages.translate.status).toBe('failed')
    expect(manifest.artifacts.chineseCues).toBeUndefined()

    runProcessMock.mockResolvedValue(providerResult(
      '1\t译文一\n2\t译文二\n3\t译文三\n',
      'translation-clean-session'
    ))
    await task.pipeline.start(task.directory)

    const completed = await task.store.load(task.directory)
    expect(completed.pipeline.stages.translate.status).toBe('completed')
    expect(completed.translation.sessionGenerations).toHaveLength(2)
    expect(completed.translation.sessionGenerations[0]).toMatchObject({ status: 'lost' })
    expect(completed.translation.sessionGenerations[1]).toMatchObject({
      status: 'active',
      reason: 'resume-replacement',
      externalSessionId: codexSessionId('translation-clean-session')
    })
  })

  it('preserves contamination when private snapshot cleanup also fails', async () => {
    const task = await cuesTask('automatic')
    const cleanupLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      removeCodexTextOnlyExecutableSnapshotMock.mockRejectedValueOnce(new Error('cleanup failed'))
      runProcessMock.mockResolvedValue({
        ...providerResult({ patches: [] }, 'contaminated-cleanup-session'),
        stderr: 'ERROR codex_core::tools::router: error=apply_patch verification failed'
      })

      await expect(task.pipeline.start(task.directory)).rejects.toThrow('纯文本阶段尝试调用工具：apply_patch')

      const failed = await task.store.load(task.directory)
      expect(failed.pipeline.stages.cues.errorCode).toContain(PROVIDER_SESSION_CONTAMINATED_PREFIX)
      expect(cleanupLog).toHaveBeenCalledWith('Codex text-only 私有快照清理失败', expect.any(Error))

      runProcessMock.mockResolvedValue(providerResult({ patches: [] }, 'replacement-after-cleanup-session'))
      await task.pipeline.start(task.directory)

      const completed = await task.store.load(task.directory)
      expect(completed.translation.sessionGenerations).toHaveLength(2)
      expect(completed.translation.sessionGenerations[0]).toMatchObject({ status: 'lost' })
      expect(completed.translation.sessionGenerations[1]).toMatchObject({
        status: 'active',
        reason: 'resume-replacement',
        externalSessionId: codexSessionId('replacement-after-cleanup-session')
      })
    } finally {
      cleanupLog.mockRestore()
    }
  })

  it('repairs invalid output three times and fails closed without publishing partial corrected artifacts', async () => {
    const task = await cuesTask('automatic')
    runProcessMock.mockResolvedValue(providerResult('not-json'))

    await expect(task.pipeline.start(task.directory)).rejects.toThrow('连续 3 次未返回可校验')

    const manifest = await task.store.load(task.directory)
    expect(manifest.pipeline.stages.cues.status).toBe('failed')
    expect(manifest.artifacts.englishClean).toBeUndefined()
    expect(manifest.artifacts.englishCues).toBeUndefined()
    expect(manifest.artifacts.englishSourceAudit).toBeUndefined()
    expect(await readFile(join(task.directory, 'english.srt'), 'utf8')).toBe(sourceSrt(3))
    expect((await readdir(task.directory)).some((file) => file.startsWith('english.clean.'))).toBe(false)
    expect(runProcessMock).toHaveBeenCalledTimes(3)
  })

  it('skips model audit for manual subtitles and leaves session creation to translation', async () => {
    const task = await cuesTask('manual')

    await task.pipeline.start(task.directory)

    const manifest = await task.store.load(task.directory)
    expect(manifest.pipeline.stages.cues.status).toBe('completed')
    expect(manifest.translation.sessionGenerations).toEqual([])
    expect(manifest.artifacts.englishClean.producer).toBe('etch-srt-v2')
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})

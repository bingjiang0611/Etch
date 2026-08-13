import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  detectTool: async (tool: string) => ({ tool, status: 'ready', executable: `/mock/${tool}`, summaryZh: `${tool} 可用` }),
  identityStillMatches: async () => true,
  toolCacheKey: (tool: string, override?: string) => `${tool}:${override ?? ''}`
}))

import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import type { RunRegistry } from '../src/main/runtime/run-registry'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, STAGE_IDS } from '../src/shared/task-schema'

const directories: string[] = []

afterEach(async () => {
  runProcessMock.mockReset()
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5 })))
})

function result(stdout = '', stderr = '', exitCode = 0) {
  return { pid: 1, exitCode, signal: null, stdout, stderr, stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false }
}

async function createDownloadTask(store: TaskStore): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-unbounded-concurrency-'))
  directories.push(directory)
  const manifest = createTaskManifest({ kind: 'url', url: 'https://vimeo.com/100000002' }, '', 'codex')
  for (const stage of STAGE_IDS) manifest.pipeline.stages[stage].status = stage === 'source' ? 'ready' : 'skipped'
  await store.create(directory, manifest)
  return directory
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition never became true')
}

describe('TaskPipeline unbounded cross-task concurrency', () => {
  it('starts more than the former three-task limit in the same stage without waiting', async () => {
    const store = new TaskStore()
    const taskDirectories = await Promise.all(Array.from({ length: 4 }, () => createDownloadTask(store)))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Set<string>()

    runProcessMock.mockImplementation(async (spec: { command: string; args: string[]; cwd: string }) => {
      if (spec.args.at(-1) === 'source.normalized.mp4') {
        await writeFile(join(spec.cwd, 'source.normalized.mp4'), 'normalized video')
        return result()
      }
      if (spec.command !== '/mock/yt-dlp') return result('1.0')
      if (!spec.cwd.includes('subtitle-fallback')) {
        started.add(spec.cwd)
        await gate
      }
      await writeFile(join(spec.cwd, 'source.mp4'), 'downloaded video')
      await writeFile(join(spec.cwd, 'source.info.json'), JSON.stringify({ id: 'video', title: 'Video', duration: 60 }))
      return result()
    })

    const pipeline = new TaskPipeline(
      store,
      defaultSettings('/Users/test'),
      new HistoricalGlossaryService(store, () => []),
      () => undefined,
      { register: async () => undefined, finish: async () => undefined } as unknown as RunRegistry
    )
    const runs = taskDirectories.map((directory) => pipeline.start(directory))

    await waitFor(() => started.size === 4)
    expect(pipeline.activeStageCount).toBe(4)
    expect(taskDirectories.map((directory) => pipeline.taskSchedule(directory))).toEqual(
      Array.from({ length: 4 }, () => ({ schedule: 'active' }))
    )

    release()
    await Promise.all(runs)
    expect(pipeline.activeStageCount).toBe(0)
  })

  it('blocks only a task owned by deletion without reducing other-task concurrency', async () => {
    const store = new TaskStore()
    const [blockedDirectory, ...allowedDirectories] = await Promise.all(
      Array.from({ length: 5 }, () => createDownloadTask(store))
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Set<string>()
    runProcessMock.mockImplementation(async (spec: { command: string; args: string[]; cwd: string }) => {
      if (spec.args.at(-1) === 'source.normalized.mp4') {
        await writeFile(join(spec.cwd, 'source.normalized.mp4'), 'normalized video')
        return result()
      }
      if (spec.command !== '/mock/yt-dlp') return result('1.0')
      if (!spec.cwd.includes('subtitle-fallback')) {
        started.add(spec.cwd)
        await gate
      }
      await writeFile(join(spec.cwd, 'source.mp4'), 'downloaded video')
      await writeFile(join(spec.cwd, 'source.info.json'), JSON.stringify({ id: 'video', title: 'Video', duration: 60 }))
      return result()
    })
    const pipeline = new TaskPipeline(
      store,
      defaultSettings('/Users/test'),
      new HistoricalGlossaryService(store, () => []),
      () => undefined,
      { register: async () => undefined, finish: async () => undefined } as unknown as RunRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (directory) => directory === blockedDirectory
    )

    await expect(pipeline.start(blockedDirectory)).rejects.toThrow('任务正在删除')
    await expect(pipeline.resume(blockedDirectory)).rejects.toThrow('任务正在删除')
    const runs = allowedDirectories.map((directory) => pipeline.start(directory))
    await waitFor(() => started.size === 4)
    expect(pipeline.activeStageCount).toBe(4)
    release()
    await Promise.all(runs)
  })
})

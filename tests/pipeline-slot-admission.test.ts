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
  const directory = await mkdtemp(join(tmpdir(), 'etch-slot-admission-'))
  directories.push(directory)
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
  for (const stage of STAGE_IDS) manifest.pipeline.stages[stage].status = stage === 'source' ? 'ready' : 'skipped'
  await store.create(directory, manifest)
  return directory
}

async function completeDownload(cwd: string): Promise<ReturnType<typeof result>> {
  await writeFile(join(cwd, 'source.mp4'), 'downloaded video')
  await writeFile(join(cwd, 'source.info.json'), JSON.stringify({ id: 'video', title: 'Video', duration: 60 }))
  return result()
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition never became true')
}

describe('TaskPipeline slot admission', () => {
  it('reports the waiting stage, refuses a manual start while the pool is full, and releases the slot afterwards', async () => {
    const store = new TaskStore()
    const first = await createDownloadTask(store)
    const second = await createDownloadTask(store)
    let releaseDownload!: () => void
    let downloadStarted!: () => void
    const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve })
    const firstDownloadStarted = new Promise<void>((resolve) => { downloadStarted = resolve })

    runProcessMock.mockImplementation(async (spec: { command: string; args: string[]; cwd: string }) => {
      if (spec.args.at(-1) === 'source.normalized.mp4') {
        await writeFile(join(spec.cwd, 'source.normalized.mp4'), 'normalized video')
        return result()
      }
      if (spec.command !== '/mock/yt-dlp') return result('1.0')
      if (spec.cwd.startsWith(first) && !spec.cwd.includes('subtitle-fallback')) {
        downloadStarted()
        await downloadGate
      }
      return completeDownload(spec.cwd)
    })

    const settings = { ...defaultSettings('/Users/test'), stageConcurrency: 1 as const }
    const pipeline = new TaskPipeline(
      store,
      settings,
      new HistoricalGlossaryService(store, () => []),
      () => undefined,
      { register: async () => undefined, finish: async () => undefined } as unknown as RunRegistry
    )

    const firstRun = pipeline.start(first)
    await firstDownloadStarted

    expect(pipeline.taskSchedule(first)).toEqual({ schedule: 'active' })
    expect(pipeline.activity()).toMatchObject({ limit: 1, pools: { download: { active: 1, waiting: 0 } } })

    await expect(pipeline.resume(second)).rejects.toThrow(/抓取并发已满（1\/1 运行中）/u)
    expect(pipeline.isRunning(second)).toBe(false)

    const secondRun = pipeline.start(second)
    await waitFor(() => pipeline.taskSchedule(second).schedule === 'waiting')
    expect(pipeline.taskSchedule(second)).toEqual({ schedule: 'waiting', waitingStage: 'source' })
    expect(pipeline.activity()).toMatchObject({ pools: { download: { active: 1, waiting: 1 } } })

    releaseDownload()
    await Promise.all([firstRun, secondRun])

    expect(pipeline.taskSchedule(first)).toEqual({ schedule: 'idle' })
    expect(pipeline.taskSchedule(second)).toEqual({ schedule: 'idle' })
    expect(pipeline.activity()).toMatchObject({ pools: { download: { active: 0, waiting: 0 } } })
  })

  it('admits a manual start once the contended pool has a free slot', async () => {
    const store = new TaskStore()
    const directory = await createDownloadTask(store)
    runProcessMock.mockImplementation(async (spec: { command: string; args: string[]; cwd: string }) => {
      if (spec.args.at(-1) === 'source.normalized.mp4') {
        await writeFile(join(spec.cwd, 'source.normalized.mp4'), 'normalized video')
        return result()
      }
      if (spec.command !== '/mock/yt-dlp') return result('1.0')
      return completeDownload(spec.cwd)
    })

    const pipeline = new TaskPipeline(
      store,
      { ...defaultSettings('/Users/test'), stageConcurrency: 1 as const },
      new HistoricalGlossaryService(store, () => []),
      () => undefined,
      { register: async () => undefined, finish: async () => undefined } as unknown as RunRegistry
    )

    await expect(pipeline.resume(directory)).resolves.toBeUndefined()
    await pipeline.whenIdle()
    expect((await store.load(directory)).pipeline.stages.source.status).toBe('completed')
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, ffmpeg } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  ffmpeg: { status: 'missing' as 'missing' | 'invalid', summaryZh: '未找到 ffmpeg', probeCancelled: false }
}))

vi.mock('../src/main/runtime/process-runner', () => ({ runProcess: runProcessMock }))
vi.mock('../src/main/runtime/shell-env', () => ({
  loginShellEnvironment: async () => ({ PATH: '/mock' }),
  operationalEnvironment: (env: NodeJS.ProcessEnv) => env,
  providerEnvironment: (_provider: string, env: NodeJS.ProcessEnv) => env,
  logChildEnvironmentKeys: () => undefined
}))
// yt-dlp resolves; ffmpeg is broken the way the current test case says it is.
vi.mock('../src/main/runtime/tool-detector', () => ({
  detectTool: async (tool: string) => tool === 'ffmpeg'
    ? { tool, status: ffmpeg.status, summaryZh: ffmpeg.summaryZh, probeCancelled: ffmpeg.probeCancelled, checkedAt: new Date().toISOString() }
    : { tool, status: 'ready', executable: `/mock/${tool}`, summaryZh: `${tool} 可用`, checkedAt: new Date().toISOString() },
  identityStillMatches: async () => true,
  toolCacheKey: (tool: string, override?: string) => `${tool}:${override ?? ''}`
}))

import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { TaskStore } from '../src/main/storage/task-store'
import type { ToolHealth } from '../src/main/runtime/tool-detector'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, STAGE_IDS } from '../src/shared/task-schema'

const directories: string[] = []

beforeEach(() => {
  ffmpeg.status = 'missing'
  ffmpeg.summaryZh = '未找到 ffmpeg'
  ffmpeg.probeCancelled = false
})

afterEach(async () => {
  runProcessMock.mockReset()
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function runSourceStage(): Promise<{ observed: ToolHealth[]; status: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'etch-pipeline-tool-health-'))
  directories.push(directory)
  const store = new TaskStore()
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
  for (const stage of STAGE_IDS) manifest.pipeline.stages[stage].status = stage === 'source' ? 'ready' : 'skipped'
  await store.create(directory, manifest)
  runProcessMock.mockResolvedValue({
    pid: 1, exitCode: 0, signal: null, stdout: '1.0', stderr: '',
    stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false
  })

  const observed: ToolHealth[] = []
  const pipeline = new TaskPipeline(
    store,
    defaultSettings('/Users/test'),
    new HistoricalGlossaryService(store, () => []),
    () => undefined,
    undefined,
    undefined,
    (health) => { observed.push(health) }
  )
  await expect(pipeline.start(directory)).rejects.toThrow(ffmpeg.summaryZh)
  return { observed, status: (await store.load(directory)).pipeline.stages.source.status }
}

describe('运行期工具健康广播', () => {
  it('reports the missing tool that failed the stage instead of leaving the last sweep stale', async () => {
    const { observed, status } = await runSourceStage()

    expect(observed.map((item) => ({ tool: item.tool, status: item.status, summaryZh: item.summaryZh })))
      .toContainEqual({ tool: 'ffmpeg', status: 'missing', summaryZh: '未找到 ffmpeg' })
    expect(observed.some((item) => item.tool === 'yt-dlp' && item.status === 'ready')).toBe(true)
    expect(status).toBe('failed')
  })

  it('reports an override whose executable was deleted, which detection calls invalid', async () => {
    ffmpeg.status = 'invalid'
    ffmpeg.summaryZh = 'ffmpeg 路径不可执行'

    const { observed, status } = await runSourceStage()

    expect(observed.some((item) => item.tool === 'ffmpeg' && item.status === 'invalid')).toBe(true)
    expect(status).toBe('failed')
  })

  it('stays silent when the probe was killed, so stopping a task cannot fake a broken tool', async () => {
    ffmpeg.status = 'invalid'
    ffmpeg.summaryZh = 'ffmpeg 无法正常执行'
    ffmpeg.probeCancelled = true

    const { observed, status } = await runSourceStage()

    expect(observed.some((item) => item.tool === 'ffmpeg')).toBe(false)
    expect(observed.some((item) => item.tool === 'yt-dlp' && item.status === 'ready')).toBe(true)
    expect(status).toBe('failed')
  })
})

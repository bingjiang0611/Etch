import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
vi.mock('../src/main/media/browser-cookies', () => ({ chromeCookieState: async () => ({ access: 'missing', browser: false }) }))

import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, STAGE_IDS } from '../src/shared/task-schema'

const directories: string[] = []

afterEach(async () => {
  runProcessMock.mockReset()
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function result(exitCode = 0, stderr = '') {
  return {
    pid: 1,
    exitCode,
    signal: null,
    stdout: '',
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false
  }
}

async function sourceFixture(onManifest: () => void = () => undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'etch-artifact-publish-'))
  directories.push(directory)
  const store = new TaskStore()
  const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' })
  for (const stage of STAGE_IDS) manifest.pipeline.stages[stage].status = stage === 'source' ? 'ready' : 'skipped'
  await store.create(directory, manifest)
  await writeFile(join(directory, 'source.mp4'), 'existing canonical bytes')

  runProcessMock.mockImplementation(async (spec: { command: string; args: string[]; cwd: string }) => {
    if (spec.command === '/mock/yt-dlp' && spec.args.includes('--skip-download')) return result(1, 'no subtitles')
    if (spec.command === '/mock/yt-dlp') {
      await writeFile(join(spec.cwd, 'source.mp4'), 'new candidate bytes')
      await writeFile(join(spec.cwd, 'source.info.json'), JSON.stringify({ id: 'video', title: 'Video', duration: 60 }))
      return result()
    }
    if (spec.command === '/mock/ffmpeg') {
      await writeFile(join(spec.cwd, spec.args.at(-1)!), 'normalized candidate bytes')
      return result()
    }
    throw new Error(`unexpected command: ${spec.command}`)
  })

  const pipeline = new TaskPipeline(
    store,
    defaultSettings('/Users/test'),
    new HistoricalGlossaryService(store, () => []),
    onManifest
  )
  return { directory, store, pipeline }
}

describe('TaskPipeline immutable artifact publication', () => {
  it('does not overwrite a canonical file and removes its run candidates after a stale CAS', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { directory, store, pipeline } = await sourceFixture()
    const commit = store.commitLease.bind(store)
    vi.spyOn(store, 'commitLease').mockImplementationOnce(async (...args) => {
      await store.mutate(directory, (manifest) => { manifest.title = 'concurrent winner' })
      return commit(...args)
    })

    await expect(pipeline.start(directory)).rejects.toThrow('候选结果已过期')

    expect(await readFile(join(directory, 'source.mp4'), 'utf8')).toBe('existing canonical bytes')
    expect((await store.load(directory)).artifacts.source).toBeUndefined()
    expect(await readdir(join(directory, '.etch-artifacts', 'source'))).toEqual(['resume'])
    expect(await readFile(join(directory, '.etch-artifacts', 'source', 'resume', 'source.mp4'), 'utf8'))
      .toBe('normalized candidate bytes')
  })

  it('keeps a committed artifact when a derived manifest consumer throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { directory, store, pipeline } = await sourceFixture(() => { throw new Error('projection unavailable') })

    await expect(pipeline.start(directory)).resolves.toBeUndefined()

    const manifest = await store.load(directory)
    expect(manifest.pipeline.stages.source.status).toBe('completed')
    expect(manifest.artifacts.source.relativePath).toMatch(/^\.etch-artifacts\/source\/[^/]+\/source\.mp4$/u)
    expect(await readFile(join(directory, manifest.artifacts.source.relativePath), 'utf8')).toBe('normalized candidate bytes')
    expect(await readFile(join(directory, 'source.mp4'), 'utf8')).toBe('normalized candidate bytes')
  })

  it('preserves a run artifact when task.json was committed but the commit call reports a later durability error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { directory, store, pipeline } = await sourceFixture()
    const commit = store.commitLease.bind(store)
    vi.spyOn(store, 'commitLease').mockImplementationOnce(async (...args) => {
      await commit(...args)
      throw new Error('directory fsync failed after rename')
    })

    await expect(pipeline.start(directory)).rejects.toThrow('directory fsync failed after rename')

    const manifest = await store.load(directory)
    expect(manifest.pipeline.stages.source.status).toBe('completed')
    expect(manifest.artifacts.source.relativePath).toMatch(/^\.etch-artifacts\/source\/[^/]+\/source\.mp4$/u)
    expect(await readFile(join(directory, manifest.artifacts.source.relativePath), 'utf8')).toBe('normalized candidate bytes')
  })

  it('lets an already-running stage commit after future acquisition is frozen', async () => {
    const { directory, store, pipeline } = await sourceFixture()
    let releaseDownload!: () => void
    const downloadBlocked = new Promise<void>((resolve) => { releaseDownload = resolve })
    const originalRun = runProcessMock.getMockImplementation()!
    runProcessMock.mockImplementation(async (spec) => {
      if (spec.command === '/mock/yt-dlp' && !spec.args.includes('--skip-download')) {
        await downloadBlocked
      }
      return originalRun(spec)
    })

    const running = pipeline.start(directory)
    await vi.waitFor(() => expect(runProcessMock.mock.calls.some(([spec]) =>
      spec.command === '/mock/yt-dlp' && !spec.args.includes('--skip-download')
    )).toBe(true))

    pipeline.freezeAcquisition()
    releaseDownload()
    await expect(running).resolves.toBeUndefined()

    expect((await store.load(directory)).pipeline.stages.source.status).toBe('completed')
  })
})

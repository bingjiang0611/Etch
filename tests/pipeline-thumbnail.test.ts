import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  detectTool: async (
    tool: string,
    _env: unknown,
    _override: unknown,
    runner: (spec: { command: string; args: string[]; cwd: string }) => Promise<unknown>
  ) => {
    await runner({ command: `/mock/${tool}`, args: ['--version'], cwd: process.cwd() })
    return { tool, status: 'ready', executable: `/mock/${tool}`, summaryZh: `${tool} 可用` }
  },
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
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function result(stdout = '', stderr = '', exitCode = 0) {
  return {
    pid: 1,
    exitCode,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false
  }
}

async function runThumbnailPipeline(options: { platformThumbnail?: boolean; fallbackFails?: boolean; height?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'etch-pipeline-thumbnail-'))
  directories.push(directory)
  const store = new TaskStore()
  const manifest = createTaskManifest({ kind: 'url', url: 'https://vimeo.com/100000004' }, '', 'codex')
  for (const stage of STAGE_IDS) manifest.pipeline.stages[stage].status = stage === 'source' ? 'ready' : stage === 'inspect' ? 'pending' : 'skipped'
  await store.create(directory, manifest)

  const register = vi.fn(async () => undefined)
  const finish = vi.fn(async () => undefined)
  let pid = 1000
  runProcessMock.mockImplementation(async (
    spec: { command: string; args: string[]; cwd: string },
    lifecycle?: { started(pid: number, executable: string): Promise<void>; finished(): Promise<void> }
  ) => {
    pid += 1
    await lifecycle?.started(pid, spec.command)
    try {
      if (spec.args[0] === '--version') return result('1.0')
      if (spec.command === '/mock/yt-dlp') {
        await writeFile(join(spec.cwd, 'source.mp4'), 'downloaded video')
        await writeFile(join(spec.cwd, 'source.info.json'), JSON.stringify({ id: 'video', title: 'Video', duration: 60 }))
        if (options.platformThumbnail) await writeFile(join(spec.cwd, 'source.webp'), 'platform thumbnail')
        return result()
      }
      if (spec.args.at(-1) === 'source.normalized.mp4') {
        await writeFile(join(spec.cwd, 'source.normalized.mp4'), 'normalized video')
        return result()
      }
      if (spec.command.endsWith('/ffprobe')) {
        return result(JSON.stringify({
          streams: [
            { codec_type: 'video', width: 1920, height: options.height ?? 1080 },
            { codec_type: 'audio' }
          ],
          format: { duration: '60' }
        }))
      }
      if (spec.args.includes('scale=640:-2')) {
        if (options.fallbackFails) return result('', 'decode failed', 1)
        await writeFile(join(spec.cwd, spec.args.at(-1)!), 'fallback thumbnail')
        return result()
      }
      throw new Error(`unexpected command: ${spec.command} ${spec.args.join(' ')}`)
    } finally {
      await lifecycle?.finished()
    }
  })

  const historical = new HistoricalGlossaryService(store, () => [])
  const runRegistry = { register, finish } as unknown as RunRegistry
  const pipeline = new TaskPipeline(store, defaultSettings('/Users/test'), historical, () => undefined, runRegistry)
  await pipeline.start(directory)
  return { directory, manifest: await store.load(directory), register, finish }
}

describe('TaskPipeline thumbnail artifacts', () => {
  it('registers the platform thumbnail downloaded by yt-dlp', async () => {
    const { directory, manifest, register, finish } = await runThumbnailPipeline({ platformThumbnail: true })

    expect(manifest.artifacts.thumbnail).toMatchObject({
      relativePath: expect.stringMatching(/^\.etch-artifacts\/source\/[^/]+\/source\.webp$/u),
      producer: 'yt-dlp-thumbnail',
      valid: true
    })
    expect(await readFile(join(directory, manifest.artifacts.thumbnail!.relativePath), 'utf8')).toBe('platform thumbnail')
    expect(runProcessMock.mock.calls.some(([spec]) => spec.args.includes('scale=640:-2'))).toBe(false)
    expect(register).toHaveBeenCalledTimes(runProcessMock.mock.calls.length)
    expect(finish).toHaveBeenCalledTimes(runProcessMock.mock.calls.length)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      taskId: manifest.taskId,
      stage: 'source',
      executable: '/mock/yt-dlp'
    }))
  })

  it('extracts and atomically publishes a fallback frame when no platform thumbnail exists', async () => {
    const { directory, manifest } = await runThumbnailPipeline()

    expect(manifest.artifacts.thumbnail).toMatchObject({
      relativePath: expect.stringMatching(/^\.etch-artifacts\/inspect\/[^/]+\/thumbnail\.jpg$/u),
      producer: 'ffmpeg-thumbnail',
      valid: true
    })
    expect(await readFile(join(directory, manifest.artifacts.thumbnail!.relativePath), 'utf8')).toBe('fallback thumbnail')
  })

  it('keeps inspect successful when optional thumbnail extraction fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { manifest } = await runThumbnailPipeline({ fallbackFails: true })

    expect(manifest.pipeline.stages.inspect.status).toBe('completed')
    expect(manifest.artifacts.thumbnail).toBeUndefined()
  })

  it('checkpoints a low-resolution source with probe artifacts and resumes after acceptance', async () => {
    const { directory, manifest } = await runThumbnailPipeline({ height: 480 })

    expect(manifest.pipeline.stages.inspect).toMatchObject({
      status: 'checkpoint',
      checkpointId: manifest.video.checkpoint?.checkpointId
    })
    expect(manifest.video.checkpoint).toMatchObject({
      kind: 'low-resolution',
      stage: 'inspect',
      metrics: { width: 1920, height: 480 }
    })
    expect(manifest.artifacts.probe.valid).toBe(true)
    expect(manifest.runtime).toMatchObject({ width: 1920, height: 480 })

    const store = new TaskStore()
    const pipeline = new TaskPipeline(store, defaultSettings('/Users/test'), new HistoricalGlossaryService(store, () => []), () => undefined)
    const accepted = await pipeline.resolveVideoCheckpoint(directory, manifest.revision, 'accept')
    expect(accepted.pipeline.stages.inspect.status).toBe('completed')
    expect(accepted.video.checkpoint).toBeUndefined()
    expect(accepted.video.decisions.at(-1)).toMatchObject({ kind: 'low-resolution', decision: 'accept' })
  })
})

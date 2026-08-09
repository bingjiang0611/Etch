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
    identity: `${tool}-identity`,
    version: `${tool} 1.0`,
    summaryZh: `${tool} 可用`
  }),
  identityStillMatches: async () => true,
  toolCacheKey: (tool: string, override?: string) => `${tool}:${override ?? ''}`
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, access: async () => undefined }
})

import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { sha256File } from '../src/main/core/fingerprint'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, STAGE_IDS, type TaskManifest } from '../src/shared/task-schema'

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

function result() {
  return {
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false
  }
}

describe('video quality checkpoints', () => {
  it('persists suspicious Whisper output and resumes without retranscribing after acceptance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-whisper-checkpoint-'))
    directories.push(directory)
    await writeFile(join(directory, 'source.mp4'), 'video fixture')
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' })
    for (const stage of STAGE_IDS) {
      manifest.pipeline.stages[stage].status = stage === 'english'
        ? 'ready'
        : ['source', 'inspect'].includes(stage) ? 'completed' : 'skipped'
    }
    manifest.runtime.subtitleKind = 'whisper'
    manifest.runtime.durationSeconds = 60
    manifest.artifacts.source = await artifact(directory, 'source.mp4')
    await store.create(directory, manifest)

    runProcessMock.mockImplementation(async (spec: { command: string; args: string[] }) => {
      expect(spec.command).toBe('/mock/mlx_whisper')
      const outputDirectory = spec.args[spec.args.indexOf('--output-dir') + 1]
      await writeFile(join(outputDirectory, 'english.srt'), [
        '1', '00:00:00,000 --> 00:00:01,000', '[Music]', '',
        '2', '00:00:01,000 --> 00:00:02,000', '[Music]', ''
      ].join('\n'))
      return result()
    })
    const pipeline = new TaskPipeline(store, defaultSettings('/Users/test'), new HistoricalGlossaryService(store, () => []), () => undefined)

    await pipeline.start(directory)

    const checkpoint = await store.load(directory)
    expect(checkpoint.pipeline.stages.english).toMatchObject({
      status: 'checkpoint',
      checkpointId: checkpoint.video.checkpoint?.checkpointId
    })
    expect(checkpoint.video.checkpoint).toMatchObject({
      kind: 'whisper-quality',
      stage: 'english',
      metrics: { cueCount: 2, musicRatio: 1 }
    })
    expect(checkpoint.artifacts.english.valid).toBe(true)
    expect(checkpoint.artifacts.whisperLog.valid).toBe(true)
    expect(runProcessMock).toHaveBeenCalledOnce()

    const accepted = await pipeline.resolveVideoCheckpoint(directory, checkpoint.revision, 'accept')
    expect(accepted.pipeline.stages.english.status).toBe('completed')
    expect(accepted.video.checkpoint).toBeUndefined()
    expect(accepted.video.decisions.at(-1)).toMatchObject({ kind: 'whisper-quality', decision: 'accept' })
    expect(runProcessMock).toHaveBeenCalledOnce()
  })
})

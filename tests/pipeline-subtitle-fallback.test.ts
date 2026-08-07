import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, chromeCookieStateMock } = vi.hoisted(() => ({ runProcessMock: vi.fn(), chromeCookieStateMock: vi.fn() }))

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
vi.mock('../src/main/media/browser-cookies', () => ({ chromeCookieState: chromeCookieStateMock }))

import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest, STAGE_IDS } from '../src/shared/task-schema'

const directories: string[] = []
const srt = '1\n00:00:00,000 --> 00:00:01,000\nHello.\n\n2\n00:00:01,000 --> 00:00:02,000\nHello again.\n\n3\n00:00:02,000 --> 00:00:03,000\nDone.\n'

beforeEach(() => {
  chromeCookieStateMock.mockResolvedValue({ access: 'granted', browser: 'chrome:Profile 2' })
})

afterEach(async () => {
  runProcessMock.mockReset()
  chromeCookieStateMock.mockReset()
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

async function runSource(
  subtitles: Record<string, unknown>,
  fallbackExitCode = 0,
  missingBrowserCookies = false,
  authenticationRequired = false,
  formatsUnavailable = false,
  fallbackFormatsUnavailable = false,
  firstDownloadTimesOut = false
) {
  const directory = await mkdtemp(join(tmpdir(), 'etch-subtitle-fallback-'))
  directories.push(directory)
  const store = new TaskStore()
  const manifest = createTaskManifest({ kind: 'url', url: 'https://youtube.com/watch?v=test' }, '', 'codex')
  for (const stage of STAGE_IDS) manifest.pipeline.stages[stage].status = stage === 'source' ? 'ready' : 'skipped'
  await store.create(directory, manifest)

  let downloadAttempts = 0
  runProcessMock.mockImplementation(async (spec: { command: string; args: string[]; cwd: string }) => {
    if (spec.command === '/mock/yt-dlp' && !spec.args.includes('--skip-download')) {
      downloadAttempts += 1
      if (firstDownloadTimesOut && downloadAttempts === 1) {
        await writeFile(join(spec.cwd, 'source.mp4.part'), 'partial video')
        return { ...result(143), timedOut: true, timeoutReason: 'inactivity' }
      }
      if (missingBrowserCookies && spec.args.includes('--cookies-from-browser')) {
        return result(1, 'ERROR: could not find chrome cookies database in "/Users/test/Chrome"')
      }
      if (formatsUnavailable && spec.args.includes('youtube:player_client=web_safari')) {
        return result(1, [
          'WARNING: [youtube] test: n challenge solving failed: Some formats may be missing',
          'WARNING: Only images are available for download',
          'ERROR: Requested format is not available. Use --list-formats for a list of available formats'
        ].join('\n'))
      }
      if (fallbackFormatsUnavailable) {
        return result(1, [
          'WARNING: [youtube] test: n challenge solving failed: Some formats may be missing',
          `WARNING: ${'diagnostic '.repeat(80)}`,
          'WARNING: Only images are available for download',
          'ERROR: No video formats found'
        ].join('\n'))
      }
      if (authenticationRequired && !spec.args.includes('--cookies-from-browser')) {
        return result(1, 'ERROR: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies')
      }
      await writeFile(join(spec.cwd, 'source.mp4'), 'video')
      await writeFile(join(spec.cwd, 'source.info.json'), JSON.stringify({ id: 'test', title: 'Test', duration: 3 }))
      return result()
    }
    if (spec.command === '/mock/yt-dlp' && spec.args.includes('--skip-download')) {
      if (fallbackExitCode) return result(fallbackExitCode, 'subtitle fetch failed')
      await writeFile(join(spec.cwd, 'source.en.srt'), srt)
      await writeFile(join(spec.cwd, 'source.info.json'), JSON.stringify({ subtitles }))
      return result()
    }
    if (spec.args.at(-1) === 'source.normalized.mp4') {
      await writeFile(join(spec.cwd, 'source.normalized.mp4'), 'video')
      return result()
    }
    throw new Error(`unexpected command: ${spec.command} ${spec.args.join(' ')}`)
  })

  const pipeline = new TaskPipeline(store, defaultSettings('/Users/test'), new HistoricalGlossaryService(store, () => []), () => undefined)
  let failure: unknown
  try {
    await pipeline.start(directory)
  } catch (error) {
    failure = error
  }
  return { directory, failure, manifest: await store.load(directory), pipeline, store }
}

describe('TaskPipeline independent subtitle fallback', () => {
  it('publishes and classifies a manual subtitle using fallback metadata', async () => {
    const { directory, manifest } = await runSource({ en: [{}] })

    expect(manifest.runtime.subtitleKind).toBe('manual')
    expect(manifest.artifacts.english).toMatchObject({
      relativePath: expect.stringMatching(/^\.etch-artifacts\/source\/[^/]+\/english\.srt$/u),
      producer: 'yt-dlp'
    })
    expect(await readFile(join(directory, 'english.srt'), 'utf8')).toBe(srt)
  })

  it('classifies an automatic fallback subtitle without using the first-pass metadata', async () => {
    const { manifest } = await runSource({})
    expect(manifest.runtime.subtitleKind).toBe('automatic')
  })

  it('keeps Whisper as the honest fallback when the isolated subtitle fetch fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { manifest } = await runSource({}, 1)
    expect(manifest.runtime.subtitleKind).toBe('whisper')
    expect(manifest.artifacts.english).toBeUndefined()
  })

  it('retries without Chrome cookies when the browser database is unavailable', async () => {
    const { manifest } = await runSource({ en: [{}] }, 0, true)
    const sourceCalls = runProcessMock.mock.calls
      .map(([spec]) => spec as { command: string; args: string[] })
      .filter((spec) => spec.command === '/mock/yt-dlp' && !spec.args.includes('--skip-download'))
    expect(sourceCalls).toHaveLength(2)
    expect(sourceCalls[0].args).toContain('--cookies-from-browser')
    expect(sourceCalls[0].args).toContain('chrome:Profile 2')
    expect(sourceCalls[1].args).not.toContain('--cookies-from-browser')
    expect(manifest.pipeline.stages.source.status).toBe('completed')
  })

  it('names the failed Chrome login read when the probe saw an accessible profile', async () => {
    const { failure, manifest } = await runSource({ en: [{}] }, 0, true, true)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('Chrome 登录状态读取失败')
    expect(manifest.pipeline.stages.source.errorCode).not.toContain('完全磁盘访问')
  })

  it('lets yt-dlp try Chrome cookies when the Etch preflight is denied', async () => {
    chromeCookieStateMock.mockResolvedValue({ access: 'denied', browser: false })
    const { manifest } = await runSource({ en: [{}] })
    const sourceCalls = runProcessMock.mock.calls
      .map(([spec]) => spec as { command: string; args: string[] })
      .filter((spec) => spec.command === '/mock/yt-dlp' && !spec.args.includes('--skip-download'))
    expect(sourceCalls).toHaveLength(1)
    expect(sourceCalls[0].args).toContain('--cookies-from-browser')
    expect(sourceCalls[0].args).toContain('chrome')
    expect(manifest.pipeline.stages.source.status).toBe('completed')
  })

  it('retries challenge failures with default clients and broader formats', async () => {
    const { directory, manifest } = await runSource({ en: [{}] }, 0, false, false, true)
    const sourceCalls = runProcessMock.mock.calls
      .map(([spec]) => spec as { command: string; args: string[] })
      .filter((spec) => spec.command === '/mock/yt-dlp' && !spec.args.includes('--skip-download'))
    expect(sourceCalls).toHaveLength(2)
    expect(sourceCalls[0].args).toContain('youtube:player_client=web_safari')
    expect(sourceCalls[1].args).not.toContain('youtube:player_client=web_safari')
    expect(sourceCalls[1].args).toContain('--remux-video')
    expect(manifest.pipeline.stages.source.status).toBe('completed')
    expect(await readFile(join(directory, manifest.artifacts.sourceLog!.relativePath), 'utf8'))
      .toContain('[Etch YouTube format fallback: default clients and formats]')
  })

  it('keeps the complete failed source log and prioritizes the final yt-dlp error', async () => {
    const { directory, failure, manifest } = await runSource({}, 0, false, false, true, true)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('ERROR: No video formats found')
    expect(manifest.pipeline.stages.source.errorCode).toContain('ERROR: No video formats found')
    expect(manifest.pipeline.stages.source.errorCode).toContain('source.failed.log')
    const diagnostic = await readFile(join(directory, 'source.failed.log'), 'utf8')
    expect(diagnostic).toContain('n challenge solving failed')
    expect(diagnostic).toContain('[Etch YouTube format fallback: default clients and formats]')
    expect(diagnostic).toContain('ERROR: No video formats found')
  })

  it('keeps partial media after inactivity timeout and resumes from the same directory', async () => {
    const { directory, failure, manifest, pipeline, store } = await runSource({}, 0, false, false, false, false, true)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('连续 10 分钟没有进度')
    expect(manifest.pipeline.stages.source.errorCode).toContain('重试将继续')
    expect(await readFile(join(directory, '.etch-artifacts', 'source', 'resume', 'source.mp4.part'), 'utf8')).toBe('partial video')
    expect(await readFile(join(directory, 'source.failed.log'), 'utf8')).toContain(
      '[Etch process result] exitCode=143 signal=null timedOut=true timeoutReason=inactivity cancelled=false'
    )

    await pipeline.start(directory)

    const resumed = await store.load(directory)
    const sourceCalls = runProcessMock.mock.calls
      .map(([spec]) => spec as { command: string; args: string[]; cwd: string; timeoutMs?: number; inactivityTimeoutMs?: number })
      .filter((spec) => spec.command === '/mock/yt-dlp' && !spec.args.includes('--skip-download'))
    expect(sourceCalls).toHaveLength(2)
    expect(sourceCalls[0].cwd).toBe(sourceCalls[1].cwd)
    expect(sourceCalls.every((spec) => spec.timeoutMs === undefined)).toBe(true)
    expect(sourceCalls.every((spec) => spec.inactivityTimeoutMs === 10 * 60_000)).toBe(true)
    expect(resumed.pipeline.stages.source.status).toBe('completed')
    expect(await readFile(join(directory, resumed.artifacts.source.relativePath), 'utf8')).toBe('video')
    expect(await readdir(join(directory, '.etch-artifacts', 'source'))).not.toContain('resume')
  })
})

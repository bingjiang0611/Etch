import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectTool, toolCacheKey } from '../src/main/runtime/tool-detector'
import type { ProcessResult, ProcessSpec } from '../src/main/runtime/process-runner'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

function result(stdout: string, exitCode = 0): ProcessResult {
  return {
    pid: 1,
    exitCode,
    signal: null,
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false
  }
}

async function executableFixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'etch-tools-'))
  directories.push(root)
  const executable = join(root, name)
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  return executable
}

describe('tool health cache configuration', () => {
  it('does not reuse health after an executable override changes or is cleared', () => {
    const standalone = toolCacheKey('yt-dlp', '/tmp/yt-dlp_macos')
    const homebrew = toolCacheKey('yt-dlp', '/opt/homebrew/bin/yt-dlp')
    const automatic = toolCacheKey('yt-dlp')

    expect(homebrew).not.toBe(standalone)
    expect(automatic).not.toBe(homebrew)
  })

  it('continues to the next PATH executable when the first one cannot run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-tools-'))
    directories.push(root)
    const brokenDirectory = join(root, 'broken')
    const readyDirectory = join(root, 'ready')
    await mkdir(brokenDirectory)
    await mkdir(readyDirectory)
    await writeFile(join(brokenDirectory, 'yt-dlp'), '#!/bin/sh\nexit 137\n')
    await writeFile(join(readyDirectory, 'yt-dlp'), '#!/bin/sh\necho "test-version"\n')
    await chmod(join(brokenDirectory, 'yt-dlp'), 0o755)
    await chmod(join(readyDirectory, 'yt-dlp'), 0o755)

    const health = await detectTool('yt-dlp', { PATH: `${brokenDirectory}:${readyDirectory}` })
    expect(health.status).toBe('ready')
    expect(health.executable).toBe(await realpath(join(readyDirectory, 'yt-dlp')))
    expect(health.version).toBe('test-version')
  }, 15_000)

  it('prefers paired Homebrew ffmpeg-full binaries over standard PATH binaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'etch-tools-'))
    directories.push(root)
    const standardDirectory = join(root, 'bin')
    const fullDirectory = join(root, 'opt/ffmpeg-full/bin')
    await mkdir(standardDirectory)
    await mkdir(fullDirectory, { recursive: true })
    for (const directory of [standardDirectory, fullDirectory]) {
      for (const executable of ['ffmpeg', 'ffprobe']) {
        const path = join(directory, executable)
        await writeFile(path, '#!/bin/sh\nexit 0\n')
        await chmod(path, 0o755)
      }
    }
    const fullFfmpeg = await realpath(join(fullDirectory, 'ffmpeg'))
    const fullFfprobe = await realpath(join(fullDirectory, 'ffprobe'))
    const env = { PATH: standardDirectory, HOMEBREW_PREFIX: root }
    const runner = async (spec: ProcessSpec): Promise<ProcessResult> => (
      result(spec.args.includes('-filters')
        ? ' .. subtitles          Render text subtitles onto input video using the libass library.'
        : 'ffmpeg version 8')
    )

    const ffmpeg = await detectTool('ffmpeg', env, undefined, runner)
    const ffprobe = await detectTool('ffprobe', env, undefined, runner)

    expect(ffmpeg).toMatchObject({ status: 'ready', executable: fullFfmpeg })
    expect(ffprobe).toMatchObject({ status: 'ready', executable: fullFfprobe })
  })

  it.each([
    {
      tool: 'claude' as const,
      executable: 'claude',
      versionArgs: ['--version'],
      authArgs: ['auth', 'status', '--json'],
      authOutput: '{"loggedIn":true}',
      summary: 'claude CLI 已登录'
    },
    {
      tool: 'codex' as const,
      executable: 'codex',
      versionArgs: ['--version'],
      authArgs: ['login', 'status'],
      authOutput: 'Logged in using ChatGPT',
      summary: 'codex CLI 已登录'
    },
    {
      tool: 'qoder' as const,
      executable: 'qodercli',
      versionArgs: ['--version'],
      authArgs: ['status'],
      authOutput: 'Version: 1.0.41\nUsername: tester\nEmail: tester@example.com',
      summary: 'qoder CLI 已登录'
    }
  ])('requires a successful local login probe for $tool', async ({
    tool,
    executable,
    versionArgs,
    authArgs,
    authOutput,
    summary
  }) => {
    const path = await executableFixture(executable)
    const calls: ProcessSpec[] = []
    const health = await detectTool(tool, { PATH: '' }, path, async (spec) => {
      calls.push(spec)
      return result(spec.args[0] === '--version' ? `${tool}-version` : authOutput)
    })

    expect(calls.map((call) => call.args)).toEqual([versionArgs, authArgs])
    expect(health.status).toBe('ready')
    expect(health.version).toBe(`${tool}-version`)
    expect(health.summaryZh).toBe(summary)
  })

  it.each([
    ['claude', 'claude', '{"loggedIn":false}', 'claude auth login'],
    ['codex', 'codex', 'Not logged in', 'codex login'],
    ['qoder', 'qodercli', '\u001b[33mAccount: Not logged in · run /login\u001b[0m', 'qodercli login']
  ] as const)('reports %s as unavailable with the concrete login command when the CLI is logged out', async (tool, executableName, authOutput, command) => {
    const executable = await executableFixture(executableName)
    const calls: ProcessSpec[] = []
    const health = await detectTool(tool, { PATH: '' }, executable, async (spec) => {
      calls.push(spec)
      return result(spec.args[0] === '--version' ? `${tool}-version` : authOutput)
    })

    expect(calls).toHaveLength(2)
    expect(health.status).toBe('invalid')
    expect(health.version).toBe(`${tool}-version`)
    expect(health.summaryZh).toBe(`${tool} 未登录，请先运行 ${command}`)
  })

  it('does not accept a successful-looking auth message from a failed probe', async () => {
    const executable = await executableFixture('codex')
    const health = await detectTool('codex', { PATH: '' }, executable, async (spec) => (
      spec.args[0] === '--version' ? result('codex-version') : result('Logged in using stale output', 1)
    ))

    expect(health.status).toBe('invalid')
    expect(health.summaryZh).toBe('codex 登录状态探测失败')
  })

  it('requires the subtitles filter from the exact resolved ffmpeg executable', async () => {
    const executable = await executableFixture('ffmpeg')
    const calls: ProcessSpec[] = []
    const ready = await detectTool('ffmpeg', { PATH: '' }, executable, async (spec) => {
      calls.push(spec)
      return result(spec.args.includes('-filters') ? ' ..S subtitles         Render text subtitles onto input video using the libass library.' : 'ffmpeg version 8')
    })

    expect(calls.map((call) => call.args)).toEqual([['-version'], ['-hide_banner', '-filters']])
    expect(ready.status).toBe('ready')

    const missing = await detectTool('ffmpeg', { PATH: '' }, executable, async (spec) => (
      result(spec.args.includes('-filters') ? ' ... scale' : 'ffmpeg version 8')
    ))
    expect(missing).toMatchObject({ status: 'invalid', summaryZh: 'ffmpeg 缺少 libass subtitles filter' })
  })

  it('does not trust truncated version or auth output', async () => {
    const executable = await executableFixture('codex')
    const truncated = (stdout: string): ProcessResult => ({
      ...result(stdout),
      stdoutTruncated: true
    })

    await expect(detectTool('codex', { PATH: '' }, executable, async () => truncated('Logged in using ChatGPT')))
      .resolves.toMatchObject({ status: 'invalid', summaryZh: 'codex 版本输出超过安全上限' })
  })
})

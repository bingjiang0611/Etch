import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSrt, serializeSrt, type SrtCue } from '../src/core/srt'
import { sha256File } from '../src/main/core/fingerprint'
import { transcribeSegmentedWhisper, type SegmentedWhisperOptions } from '../src/main/media/whisper-segments'
import type { ProcessResult, ProcessSpec } from '../src/main/runtime/process-runner'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    pid: 1,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    ...overrides
  }
}

function segmentCues(start: number): SrtCue[] {
  if (start === 0) return [
    { id: '1', startMs: 100, endMs: 900, lines: ['First'] },
    { id: '2', startMs: 1_198_000, endMs: 1_199_900, lines: ['Shared overlap'] }
  ]
  if (start === 1198) return [
    { id: '1', startMs: 0, endMs: 1_900, lines: ['Shared overlap'] },
    { id: '2', startMs: 2_000, endMs: 3_000, lines: ['Second'] }
  ]
  return [{ id: '1', startMs: 1_000, endMs: 2_000, lines: ['Third'] }]
}

async function fixture(
  failSecondOnce = false
): Promise<{ options: SegmentedWhisperOptions; mlxStarts: number[]; ffmpegStarts: number[] }> {
  const taskDirectory = await mkdtemp(join(tmpdir(), 'etch-whisper-segments-'))
  directories.push(taskDirectory)
  const sourcePath = join(taskDirectory, 'source.mp4')
  await writeFile(sourcePath, 'media')
  const mlxStarts: number[] = []
  const ffmpegStarts: number[] = []
  let failed = false
  const run = async (spec: ProcessSpec): Promise<ProcessResult> => {
    if (spec.command === '/fake/ffmpeg') {
      const start = Number(spec.args[spec.args.indexOf('-ss') + 1])
      ffmpegStarts.push(start)
      await writeFile(join(spec.cwd, 'segment.wav'), `audio-${start}`)
      return result()
    }
    const start = Number((await readFile(join(spec.cwd, 'segment.wav'), 'utf8')).slice('audio-'.length))
    mlxStarts.push(start)
    if (failSecondOnce && start === 1198 && !failed) {
      failed = true
      return result({ exitCode: 1, stderr: 'transient failure' })
    }
    await writeFile(join(spec.cwd, 'english.srt'), serializeSrt(segmentCues(start)))
    return result()
  }
  return {
    mlxStarts,
    ffmpegStarts,
    options: {
      taskDirectory,
      sourceRelativePath: 'source.mp4',
      sourceSha256: await sha256File(sourcePath),
      sourceSize: (await stat(sourcePath)).size,
      durationSeconds: 2401,
      ffmpeg: '/fake/ffmpeg',
      ffmpegIdentity: '5:6:7:8',
      ffmpegVersion: 'ffmpeg 8.0',
      ffmpegSha256: '3'.repeat(64),
      mlxWhisper: '/fake/mlx_whisper',
      mlxIdentity: '1:2:3:4',
      mlxVersion: 'mlx-whisper 1.0',
      mlxSha256: '2'.repeat(64),
      modelSnapshot: '/fake/model',
      modelRevision: 'a'.repeat(40),
      env: {},
      run
    }
  }
}

describe('transcribeSegmentedWhisper', () => {
  it('publishes three recoverable segments, reuses them, and removes overlap duplicates', async () => {
    const task = await fixture()
    const first = await transcribeSegmentedWhisper(task.options)
    const second = await transcribeSegmentedWhisper(task.options)
    const cues = parseSrt(first.srt)

    expect(first).toMatchObject({ segmentCount: 3, reusedSegments: 0 })
    expect(second).toMatchObject({ segmentCount: 3, reusedSegments: 3 })
    expect(task.mlxStarts).toEqual([0, 1198, 2398])
    expect(task.ffmpegStarts).toEqual([0, 1198, 2398])
    expect(cues.map((cue) => cue.lines.join(' '))).toEqual(['First', 'Shared overlap', 'Second', 'Third'])
    expect(cues.map((cue) => cue.id)).toEqual(['1', '2', '3', '4'])
  })

  it('rejects an in-place source replacement before reusing cached segments', async () => {
    const task = await fixture()
    await transcribeSegmentedWhisper(task.options)
    await writeFile(join(task.options.taskDirectory, task.options.sourceRelativePath), 'MEDIA')

    await expect(transcribeSegmentedWhisper(task.options)).rejects.toThrow('SHA-256 不匹配')
    expect(task.mlxStarts).toEqual([0, 1198, 2398])
    expect(task.ffmpegStarts).toEqual([0, 1198, 2398])
  })

  it('extracts every cache miss from one verified snapshot if the source path changes mid-run', async () => {
    const task = await fixture()
    const sourcePath = join(task.options.taskDirectory, task.options.sourceRelativePath)
    const originalRun = task.options.run
    let changed = false
    task.options.run = async (spec) => {
      if (spec.command === '/fake/ffmpeg' && !changed) {
        changed = true
        await writeFile(sourcePath, 'MEDIA')
        const snapshotPath = spec.args[spec.args.indexOf('-i') + 1]
        expect(snapshotPath).not.toBe(sourcePath)
        expect(await readFile(snapshotPath, 'utf8')).toBe('media')
      }
      return originalRun(spec)
    }

    const first = await transcribeSegmentedWhisper(task.options)
    await writeFile(sourcePath, 'media')
    const second = await transcribeSegmentedWhisper(task.options)

    expect(first.srt).toBe(second.srt)
    expect(second.reusedSegments).toBe(3)
    expect(task.mlxStarts).toEqual([0, 1198, 2398])
  })

  it('keeps completed segment caches when a later segment fails and resumes from that boundary', async () => {
    const task = await fixture(true)

    await expect(transcribeSegmentedWhisper(task.options)).rejects.toThrow('transient failure')
    expect((await readdir(join(task.options.taskDirectory, '.etch-whisper-cache')))
      .filter((name) => name.startsWith('.candidate-'))).toEqual([])
    const resumed = await transcribeSegmentedWhisper(task.options)

    expect(resumed.reusedSegments).toBe(1)
    expect(task.mlxStarts).toEqual([0, 1198, 1198, 2398])
    expect(task.ffmpegStarts).toEqual([0, 1198, 1198, 2398])
  })

  it('accepts a truly silent segment but rejects a non-empty malformed SRT', async () => {
    const silent = await fixture()
    const silentRun = silent.options.run
    silent.options.run = async (spec) => {
      if (spec.command === '/fake/mlx_whisper') {
        const start = Number((await readFile(join(spec.cwd, 'segment.wav'), 'utf8')).slice('audio-'.length))
        if (start === 1198) {
          silent.mlxStarts.push(start)
          await writeFile(join(spec.cwd, 'english.srt'), ' \n')
          return result()
        }
      }
      return silentRun(spec)
    }
    const transcript = await transcribeSegmentedWhisper(silent.options)
    expect(parseSrt(transcript.srt).map((cue) => cue.lines.join(' '))).toEqual(['First', 'Shared overlap', 'Third'])

    const malformed = await fixture()
    const malformedRun = malformed.options.run
    malformed.options.run = async (spec) => {
      if (spec.command === '/fake/mlx_whisper') {
        const start = Number((await readFile(join(spec.cwd, 'segment.wav'), 'utf8')).slice('audio-'.length))
        if (start === 1198) {
          malformed.mlxStarts.push(start)
          await writeFile(join(spec.cwd, 'english.srt'), 'not-an-id\n00:00:00,000 --> 00:00:01,000\ntext\n')
          return result()
        }
      }
      return malformedRun(spec)
    }
    await expect(transcribeSegmentedWhisper(malformed.options)).rejects.toThrow('无效 block')
  })

  it('recomputes a tampered cache and treats executable bytes as part of the cache identity', async () => {
    const task = await fixture()
    await transcribeSegmentedWhisper(task.options)
    const cacheRoot = join(task.options.taskDirectory, '.etch-whisper-cache')
    const cacheDirectories = (await readdir(cacheRoot)).filter((name) => !name.startsWith('.'))
    for (const name of cacheDirectories) {
      const sidecar = JSON.parse(await readFile(join(cacheRoot, name, 'segment.json'), 'utf8')) as {
        identity: { startMilliseconds: number }
      }
      if (sidecar.identity.startMilliseconds === 0) {
        await writeFile(join(cacheRoot, name, 'english.srt'), 'tampered')
      }
    }

    const repaired = await transcribeSegmentedWhisper(task.options)
    expect(repaired.reusedSegments).toBe(2)
    expect(task.mlxStarts).toEqual([0, 1198, 2398, 0])

    const changedExecutable = await transcribeSegmentedWhisper({
      ...task.options,
      mlxSha256: '3'.repeat(64)
    })
    expect(changedExecutable.reusedSegments).toBe(0)
    expect(task.mlxStarts.slice(-3)).toEqual([0, 1198, 2398])
  })

  it('isolates concurrently published bytes that disagree under the same cache key', async () => {
    const task = await fixture()
    let firstSegmentCalls = 0
    let release!: () => void
    const bothReady = new Promise<void>((resolve) => { release = resolve })
    const originalRun = task.options.run
    task.options.run = async (spec) => {
      if (spec.command === '/fake/mlx_whisper') {
        const start = Number((await readFile(join(spec.cwd, 'segment.wav'), 'utf8')).slice('audio-'.length))
        if (start === 0) {
          firstSegmentCalls += 1
          const label = firstSegmentCalls === 1 ? 'Candidate A' : 'Candidate B'
          await writeFile(join(spec.cwd, 'english.srt'), serializeSrt([
            { id: '1', startMs: 100, endMs: 900, lines: [label] }
          ]))
          if (firstSegmentCalls === 2) release()
          await bothReady
          return result()
        }
      }
      return originalRun(spec)
    }

    const settled = await Promise.allSettled([
      transcribeSegmentedWhisper(task.options),
      transcribeSegmentedWhisper(task.options)
    ])
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')
    expect(String(rejected?.reason)).toContain('身份冲突')
    expect((await readdir(join(task.options.taskDirectory, '.etch-whisper-cache')))
      .some((name) => name.startsWith('.conflict-'))).toBe(true)
  })

  it('refuses a symlinked segment cache root', async () => {
    const task = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'etch-whisper-cache-outside-'))
    directories.push(outside)
    await symlink(outside, join(task.options.taskDirectory, '.etch-whisper-cache'))

    await expect(transcribeSegmentedWhisper(task.options)).rejects.toThrow('根目录必须是普通目录')
  })

  it('keeps the combined multi-segment diagnostic log within one bounded tail', async () => {
    const task = await fixture()
    const originalRun = task.options.run
    task.options.run = async (spec) => ({
      ...await originalRun(spec),
      stdout: 'o'.repeat(2 * 1024 * 1024),
      stderr: 'e'.repeat(2 * 1024 * 1024)
    })

    const transcript = await transcribeSegmentedWhisper(task.options)

    expect(Buffer.byteLength(transcript.log)).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(transcript.log).toContain('[Etch segmented Whisper diagnostic tail truncated]')
  })
})
